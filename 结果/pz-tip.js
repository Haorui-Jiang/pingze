/**
 * 结果/pz-tip.js —— 「逐字平仄」单字悬停弹窗（所属韵部 + 跳转平水韵页）
 *
 * 需求：鼠标移到结果区某个字上，在文字上方弹出小窗，列出该字所属的**全部**韵部；
 * 一字多韵（多音多义）时全部列出，每个韵部都是超链接，跳到 /pingshui-yun
 * 页面对应韵部的位置（自动展开、滚动定位、高亮该字）。
 *
 * 设计约束：
 *   · 纯前端、零依赖，只读 window.PINGSHUI_YUN（与 pingze-engine.js 同一份数据）。
 *     106 个韵部名（上平一东…入声十七霁）在全表内唯一，可直接当锚点键，
 *     所以链接用「#yun-<序号>-<字>」而不是名字，序号由本模块现查，链接不会写死。
 *   · 弹窗本体是页面里唯一一个 fixed 定位的元素（不受结果区栅格布局影响），
 *     定位用 getBoundingClientRect：默认贴字的上方，上方空间不足自动翻到下方，
 *     水平方向做视口夹取，边缘的字也不会被裁掉。
 *   · 事件全部用**委托**绑在 #pzGrid 上：结果区每次查询都是 innerHTML 整体重绘，
 *     逐格绑定会随重绘丢失。
 *   · 触屏没有 hover：click 单元格也能弹出/收起。
 *
 * 兼容 Node：可在 tools/ 的冒烟脚本里 require（纯逻辑函数直接单测）。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PZTip = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  /** 平水韵韵部对照表地址（与 nav / footer 里的站内地址保持一致） */
  var YUN_PAGE = '/pingshui-yun';

  /** 单元格 → 弹窗的鼠标离开宽限（毫秒）：够把鼠标移到弹窗里的链接上 */
  var HIDE_DELAY = 160;
  /** 触屏 tap 会先合成 mouseover 再 click，400ms 内的 click 视为同一次触摸的收尾 */
  var TAP_GRACE = 400;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function yunData() {
    var d = root && root.PINGSHUI_YUN;
    return d && Array.isArray(d.yun) ? d : null;
  }

  /**
   * 韵部名 → { tone, ord, ping }。
   * 韵部名在全表唯一，直接做键；找不到返回 null（调用方按「未知」渲染，不抛错）。
   */
  function yunMeta(name) {
    var d = yunData();
    if (!d) return null;
    for (var i = 0; i < d.yun.length; i++) {
      if (d.yun[i].t + d.yun[i].n === name) {
        return { tone: d.yun[i].t, ord: d.yun[i].o, ping: d.yun[i].p === '平' };
      }
    }
    return null;
  }

  /**
   * 韵部 → 平水韵页锚点链接：/pingshui-yun#yun-<序号>[-<字>]。
   * 该页面的 applyHash() 会据此展开对应韵部、滚动定位并高亮该字。
   * 数据缺失或韵部名对不上时退回韵部页首页（宁可少跳一步，也不要跳到错位置）。
   */
  function yunHref(name, ch) {
    var d = yunData();
    if (d) {
      for (var i = 0; i < d.yun.length; i++) {
        if (d.yun[i].t + d.yun[i].n === name) {
          return YUN_PAGE + '#yun-' + i + (ch ? '-' + encodeURIComponent(ch) : '');
        }
      }
    }
    return YUN_PAGE;
  }

  /** 「平 / 仄 / 通 / 未收录」标签（与格子里下方的标注一致） */
  function toneLabel(tone) {
    if (tone === '平') return { text: '平', cls: 'ping' };
    if (tone === '仄') return { text: '仄', cls: 'ze' };
    if (tone === '通') return { text: '通', cls: 'tong' };
    return { text: '未收录', cls: 'unknown' };
  }

  /**
   * 生成弹窗内部 HTML。
   * @param {{ch:string, tone:string, yun:string[]}} cell 引擎给出的单元格数据
   */
  function tipHtml(cell) {
    var ch = cell.ch;
    var tone = toneLabel(cell.tone);
    var head = '<div class="pt-hd">' +
      '<span class="pt-ch">' + esc(ch) + '</span>' +
      '<span class="pt-tone ' + tone.cls + '">' + tone.text + '</span>' +
      '</div>';

    var yun = cell.yun || [];
    if (!yun.length) {
      return head +
        '<div class="pt-none">平水韵 106 韵未收此字，多为后起字或异体写法。</div>';
    }

    var chips = yun.map(function (name) {
      var meta = yunMeta(name);
      var badge = meta
        ? '<i class="pt-badge ' + (meta.ping ? 'ping' : 'ze') + '">' + (meta.ping ? '平' : '仄') + '</i>'
        : '';
      return '<a class="pt-yun" href="' + esc(yunHref(name, ch)) + '" target="_blank" rel="noopener">' +
        esc(name) + badge + '</a>';
    }).join('');

    return head +
      '<div class="pt-chips">' + chips + '</div>' +
      '<div class="pt-ft">点韵部名，在新标签打开该韵部并高亮「' + esc(ch) + '」字</div>';
  }

  // ---------- DOM 交互（仅浏览器；Node 下不挂载） ----------

  /** 视口宽度（iOS Safari 下 innerWidth 可靠，但兜一层 documentElement） */
  function viewportW() {
    var de = root.document && root.document.documentElement;
    return (root.innerWidth || (de && de.clientWidth) || 360);
  }

  /** 视口高度 */
  function viewportH() {
    var de = root.document && root.document.documentElement;
    return (root.innerHeight || (de && de.clientHeight) || 640);
  }

  /**
   * 把弹窗摆到单元格上方（空间不够则翻到下方），水平方向夹在视口内。
   * 先 visibility:hidden 再量尺寸，避免摆位过程闪一下。
   */
  function place(tip, cell) {
    var r = cell.getBoundingClientRect();
    tip.classList.add('on');
    tip.style.visibility = 'hidden';
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;

    var vh = viewportH();
    var top = r.top - th - 10;          // 默认：字的正上方
    if (top < 8) top = r.bottom + 10;    // 上方放不下（首行字）→ 翻到下方
    var left = r.left + r.width / 2 - tw / 2;

    // 水平、垂直双向夹取：首行字翻到下方后仍可能顶出视口（如底部字），此时贴住视口边缘
    var maxLeft = viewportW() - tw - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;
    var maxTop = vh - th - 8;
    if (top > maxTop) top = Math.max(8, maxTop);

    tip.style.top = Math.round(top) + 'px';
    tip.style.left = Math.round(left) + 'px';
    tip.style.visibility = '';
  }

  /**
   * 挂载：在结果区容器上做事件委托，控制唯一一个弹窗元素。
   * @param {Element} grid  #pzGrid（逐字平仄结果容器）
   * @param {Element} tip  弹窗元素（页面里预留，position:fixed）
   */
  function attach(grid, tip) {
    if (!grid || !tip || !root.document) return null;

    var curCell = null;   // 当前弹窗对应的单元格
    var hideTimer = null;
    var shownAt = 0;      // 弹窗显示时刻（用于识别触屏的合成事件序列）

    function hide() {
      tip.classList.remove('on');
      curCell = null;
    }

    function scheduleHide() {
      if (hideTimer) root.clearTimeout(hideTimer);
      hideTimer = root.setTimeout(hide, HIDE_DELAY);
    }

    function cancelHide() {
      if (hideTimer) { root.clearTimeout(hideTimer); hideTimer = null; }
    }

    function show(cell) {
      cancelHide();
      curCell = cell;
      tip.innerHTML = tipHtml({
        ch: cell.getAttribute('data-ch') || '',
        tone: cell.getAttribute('data-tone') || '',
        yun: (cell.getAttribute('data-yun') || '').split('|').filter(Boolean),
      });
      place(tip, cell);
      shownAt = Date.now();
    }

    function cellOf(node) {
      if (!node || !node.closest) return null;
      var el = node.closest('.pz-cell');
      return el && grid.contains(el) ? el : null;
    }

    grid.addEventListener('mouseover', function (e) {
      var cell = cellOf(e.target);
      if (!cell) return;
      if (cell === curCell) { cancelHide(); return; }
      show(cell);
    });

    grid.addEventListener('mouseleave', function () { scheduleHide(); });

    grid.addEventListener('click', function (e) {
      var cell = cellOf(e.target);
      if (!cell) return;
      // 触屏 tap：mouseover 已经弹出来了，这次 click 只做「点空白处收起」
      if (cell === curCell && Date.now() - shownAt < TAP_GRACE) return;
      if (cell === curCell) hide();
      else show(cell);
    });

    // 鼠标移进弹窗本体：取消隐藏，让里面的链接可点
    tip.addEventListener('mouseenter', cancelHide);
    tip.addEventListener('mouseleave', scheduleHide);

    // 点弹窗以外的地方收起
    root.document.addEventListener('click', function (e) {
      if (!curCell) return;
      if (tip.contains(e.target) || cellOf(e.target)) return;
      hide();
    });

    // 位置是按视口坐标算的，滚动/缩放后必然错位 —— 直接收起最省事
    root.addEventListener('scroll', function () { if (curCell) hide(); }, true);
    root.addEventListener('resize', function () { if (curCell) hide(); });

    root.document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && curCell) hide();
    });

    return { show: show, hide: hide };
  }

  return {
    YUN_PAGE: YUN_PAGE,
    esc: esc,
    yunMeta: yunMeta,
    yunHref: yunHref,
    toneLabel: toneLabel,
    tipHtml: tipHtml,
    attach: attach,
  };
});
