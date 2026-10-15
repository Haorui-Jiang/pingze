/**
 * 结果/pingze-engine.js —— 平仄 / 韵部 / 重字 本地查表引擎（V5 核心）
 *
 * 背景：AI（大模型）逐字判平仄不可靠，V5 起改回「字典查表」——
 * 复刻国粹网 pz.asp（V4.2）的判定逻辑，全部计算在浏览器本地完成：
 * 零服务端成本、断网可用、毫秒级返回、结果确定可复现。
 * 逆向依据见 research/V4.2后台逻辑分析.html。
 *
 * 数据来源：结果/pingshui-yun-data.js（window.PINGSHUI_YUN，平水韵 106 韵）。
 * 本引擎只读它、不新建字典文件 —— 「字 → 韵部」反查与古平仄推导全部现算：
 *   · 只入平声韵（上平/下平）      → 平
 *   · 只入仄声韵（上声/去声/入声）  → 仄
 *   · 平声韵与仄声韵都入（多音字）  → 通
 *   · 韵部全都没有（后起字/异体）   → 未收录（全角空格占位）
 *
 * 六步流水线（与 V4.2 逐条对齐）：
 *   1. 限长：清洗后总字符数 > 1000 直接中止
 *   2. 清洗：删半角空格 / 全角空格 U+3000 / Tab（\r 一并删，换行符 artifact）
 *   3. 分句：硬编码符号表替换为换行后切分，丢空句（连续标点自动合并、
 *      首尾标点不产空句）；输入里的换行同样强制分句
 *   4. 逐字查平仄：古平仄串与文本逐字符一一对应，未收录补全角空格占位
 *   5. 尾字查韵目：只查每分句最后一个字；无韵目则回退一位；再无则放弃
 *   6. 全局重字：清洗后全文字频 ≥2 的全部标红（不做繁简归一）
 *
 * 能力边界（刻意保持克制，与 V4.2 一致）：
 *   不判文体、不校验格律（粘对/孤平/三平尾/拗救）、不校验押韵、
 *   不做马蹄韵、不区分同位/异位重字、不做上下文消歧。
 *   这些交给可选的 AI 赏析（index.html 双开关），且仅作提示。
 *
 * 兼容 Node：可在测试里 require（见 tools/ 冒烟脚本），浏览器挂 window.PINGZE_ENGINE。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PINGZE_ENGINE = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  /** 总字数上限（V4.2 口径：清洗后的字符数，含标点） */
  var MAX_LEN = 1000;

  /**
   * 触发分句的符号表 —— 逐字符实测自 V4.2，刻意保持原样（含看似不对称的取舍：
   * 《》断句但〈〉不断；/ 断句但全角／不断；- 和 _ 断句但 + = * 不断；
   * ASCII 单引号 ' 断句但 ASCII 双引号 " 不断）。
   */
  var SEPARATORS =
    '，。；！？、：·—…（）《》【》“”‘’' + // 全角标点
    ',.;!?:()[]{}/\\|-_' +             // 半角标点
    "'";                               // ASCII 单引号（双引号 " 按 V4.2 属占位符，不断句）

  /** 韵目规范排序：上平 → 下平 → 上声 → 去声 → 入声 */
  var TONE_RANK = { '上平': 0, '下平': 1, '上声': 2, '去声': 3, '入声': 4 };

  var IDX = null; // 字 → { ping:bool, ze:bool, yun:[{name,tone,ord}] }

  /** 读取韵表数据（浏览器读 window.PINGSHUI_YUN；Node 测试读 global.PINGSHUI_YUN） */
  function getYunData() {
    if (root && root.PINGSHUI_YUN) return root.PINGSHUI_YUN;
    if (typeof PINGSHUI_YUN !== 'undefined' && PINGSHUI_YUN) return PINGSHUI_YUN;
    return null;
  }

  function yunNames(rec) {
    return rec.yun.map(function (y) { return y.name; });
  }

  /** 构建「字 → 韵部/平仄」反查索引（懒加载，只建一次） */
  function buildIndex() {
    if (IDX) return IDX;
    var DATA = getYunData();
    var idx = Object.create(null);
    if (DATA && Array.isArray(DATA.yun)) {
      DATA.yun.forEach(function (y) {
        var isPing = y.p === '平';
        var seenInYun = Object.create(null); // 同韵部内重复字只记一次
        for (var k = 0; k < y.c.length; k++) {
          var ch = y.c[k];
          if (seenInYun[ch]) continue;
          seenInYun[ch] = 1;
          var rec = idx[ch] || (idx[ch] = { ping: false, ze: false, yun: [] });
          if (isPing) rec.ping = true; else rec.ze = true;
          rec.yun.push({ name: y.t + y.n, tone: y.t, ord: y.o });
        }
      });
      // 多音字韵目按规范声调序排列（源数据若乱序，这里统一纠正）
      Object.keys(idx).forEach(function (ch) {
        idx[ch].yun.sort(function (a, b) {
          var ra = TONE_RANK[a.tone];
          var rb = TONE_RANK[b.tone];
          if (ra !== rb) return ra - rb;
          return a.ord - b.ord;
        });
      });
    }
    IDX = idx;
    return IDX;
  }

  /**
   * 主入口：分析一段文本。
   * @param {string} raw 用户原始输入
   * @returns {{ok:true, text, total, ping, ze, tong, unknown, lines, dupChars, tongChars}
   *          |{ok:false, error}} lines[].cells 逐字含 tone 与韵部；
   *          lines[].tail/tailYun 为尾字（可能回退）与其韵部。
   */
  function analyze(raw) {
    var idx = buildIndex();
    var src = raw == null ? '' : String(raw);

    // 1+2) 清洗：空白类字符删除（换行保留 —— 它是分句符）
    var s = src.replace(/[ \t\u3000\r]/g, '');

    // 1) 限长（V4.2：清洗后计数，含标点）
    if (s.length > MAX_LEN) {
      return { ok: false, error: '抱歉，总字数不能超过 ' + MAX_LEN + ' 字，请删减后再查询。' };
    }

    // 3) 分句
    for (var i = 0; i < SEPARATORS.length; i++) {
      s = s.split(SEPARATORS[i]).join('\n');
    }
    var lines = s.split('\n').filter(function (l) { return l.length > 0; });
    if (!lines.length) {
      return { ok: false, error: '没有可查询的有效字符（输入全是标点或空白）。' };
    }

    var out = {
      ok: true,
      text: lines.join(''), // 清洗+去标点后的全文（保存/重字统计用）
      total: 0, ping: 0, ze: 0, tong: 0, unknown: 0,
      lines: [], dupChars: [], tongChars: [],
    };
    var tongSeen = Object.create(null);

    lines.forEach(function (ln) {
      var gu = '';
      var cells = [];
      for (var j = 0; j < ln.length; j++) {
        var ch = ln.charAt(j);
        var rec = idx[ch];
        var tone = '';
        var yun = [];
        if (!rec) {
          tone = ''; // 未收录 → 全角空格占位，位置不塌
        } else if (rec.ping && rec.ze) {
          tone = '通';
          yun = yunNames(rec);
          if (!tongSeen[ch]) { tongSeen[ch] = 1; out.tongChars.push(ch); }
        } else if (rec.ping) {
          tone = '平';
          yun = yunNames(rec);
        } else {
          tone = '仄';
          yun = yunNames(rec);
        }
        gu += tone === '' ? '\u3000' : tone;
        cells.push({ ch: ch, tone: tone, yun: yun });
        if (tone === '平') out.ping++;
        else if (tone === '仄') out.ze++;
        else if (tone === '通') out.tong++;
        else out.unknown++;
      }
      out.total += ln.length;

      // 5) 尾字韵目：只查末字；查不到回退一位；再无则放弃（输出空 ◆）
      var tail = ln.charAt(ln.length - 1);
      var tailRec = idx[tail];
      var tailYun = tailRec ? yunNames(tailRec) : [];
      var fallback = false;
      if (!tailYun.length && ln.length >= 2) {
        var prev = ln.charAt(ln.length - 2);
        var prevRec = idx[prev];
        if (prevRec) {
          var prevYun = yunNames(prevRec);
          if (prevYun.length) {
            tail = prev;
            tailYun = prevYun;
            fallback = true;
          }
        }
      }

      out.lines.push({
        text: ln, gu: gu, jin: null, // 今平仄暂缺（见 tasks.md A4），结构预留
        tail: tail, tailYun: tailYun, tailFallback: fallback,
        cells: cells,
      });
    });

    // 6) 全局重字：字频 ≥2（字母数字同样参与；标点已在分句阶段切除）
    var all = out.text;
    var freq = Object.create(null);
    for (var k = 0; k < all.length; k++) {
      var c = all.charAt(k);
      freq[c] = (freq[c] || 0) + 1;
    }
    var seen = Object.create(null);
    for (var m = 0; m < all.length; m++) {
      var c2 = all.charAt(m);
      if (seen[c2]) continue;
      seen[c2] = 1;
      if (freq[c2] >= 2) out.dupChars.push(c2);
    }

    return out;
  }

  /**
   * 把查表结果压成一段紧凑文本，作为 AI 赏析的输入附件
   * （让模型基于确定数据说话，不重新逐字判平仄）。
   */
  function tableText(res) {
    if (!res || !res.ok) return '';
    return res.lines.map(function (ln) {
      var yunPart = ln.tailYun.length ? '【' + ln.tailYun.join('、') + '】' : '';
      return ln.text + '｜古：' + ln.gu + '｜尾字：' + ln.tail + yunPart;
    }).join('\n') +
      (res.dupChars.length ? '\n重字：' + res.dupChars.join('、') : '') +
      (res.tongChars.length ? '\n多音字（标「通」）：' + res.tongChars.join('、') : '');
  }

  return {
    MAX_LEN: MAX_LEN,
    SEPARATORS: SEPARATORS,
    analyze: analyze,
    tableText: tableText,
    /** 测试/调试用：索引是否已建、收录字数 */
    _debug: function () {
      var idx = buildIndex();
      return { chars: Object.keys(idx).length };
    },
  };
});
