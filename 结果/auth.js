/**
 * 平仄查询站 · Supabase 前端集成（V5）
 *
 * 依赖顺序（在 index.html 中）：
 *   supabase UMD → supabase-config.js → 本文件
 *
 * V5 变化（2026-10-16）：
 *   · 平仄/韵部查询改为浏览器本地查表（pingze-engine.js），永久免费、不走这里；
 *   · 「我的分析 / 我的作品」下线， poems / analyses 表已删（迁移 0007）；
 *   · 新增「查询记录」：登录用户的查询输入+结果存 queries 表（只增/删，不可改）；
 *   · AI 赏析配额改读 profiles 轻量列（rpc ai_usage_today），不再有 usage_today()。
 *
 * 降级原则：只要配置缺失或 CDN 没加载成功，整套登录功能静默关闭，
 * 原有的「匿名查表」链路必须照常可用 —— 不能因为接了账号系统就把站搞挂。
 */
/* global supabase */
(function () {
  'use strict';

  var CFG = window.PINGZE_SUPABASE || {};
  var STARTSWITH_HTTP = /^https?:\/\//;
  var READY =
    Boolean(CFG.url && CFG.anonKey) &&
    STARTSWITH_HTTP.test(CFG.url) &&
    window.supabase &&
    typeof window.supabase.createClient === 'function';

  var client = READY
    ? window.supabase.createClient(CFG.url, CFG.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;

  var currentUser = null;
  var mode = 'signin'; // signin | signup
  var lastInput = '';
  var lastResult = null;
  // 已经保存过的查询输入；用于防止对同一次查询结果重复入库
  var savedForInput = '';
  var currentQueryId = null;
  // 会员/配额状态（由 ai_usage_today() 与后端 429 回包更新）
  var currentTier = 'free';
  var memberExpiresAt = null;

  /** 额度说明：免费每日 3 次 AI 赏析，会员每日 10 次（迁移 0007_v5_query_engine.sql）。
   *  查表功能本身永久免费、不计次。 */
  var DAILY_QUOTA = 10;

  /** AI 赏析类型 → 中文标签（与后端 lib/ai-insight.js 的 TYPES 白名单一致） */
  var AI_KIND_LABEL = { analysis: 'AI 平仄分析', appreciation: 'AI 诗词鉴赏' };

  /** content 列上限，与迁移 20261016094246 的 check 约束一致 */
  var AI_CONTENT_MAX = 8000;

  function $(id) {
    return document.getElementById(id);
  }
  function setDisplay(id, visible, defaultDisplay) {
    var node = $(id);
    if (!node) return;
    node.style.display = visible ? defaultDisplay || '' : 'none';
  }
  function tip(msg, isError) {
    var node = $('authTip');
    if (!node) return;
    node.textContent = msg || '';
    node.className = isError ? 'hint err-tip' : 'hint';
  }
  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    // 固定按东八区（Asia/Shanghai，全年 UTC+8、无夏令时）渲染，
    // 不受浏览器时区影响，与管理后台时间口径一致
    var cn = new Date(d.getTime() + 8 * 3600 * 1000);
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return cn.getUTCFullYear() + '-' + pad(cn.getUTCMonth() + 1) + '-' + pad(cn.getUTCDate()) +
      ' ' + pad(cn.getUTCHours()) + ':' + pad(cn.getUTCMinutes());
  }
  /** 从查表结果里提取统计数字（供记录列表标签用） */
  function summarize(result) {
    if (!result || !result.ok) return null;
    return { ping: result.ping || 0, ze: result.ze || 0, tong: result.tong || 0, total: result.total || 0 };
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ---------------------------------------------------------------- 会话

  async function getToken() {
    if (!client) return null;
    try {
      var res = await client.auth.getSession();
      var s = res && res.data && res.data.session;
      return s ? s.access_token : null;
    } catch (e) {
      return null;
    }
  }

  /** 给 /api/ai-insight 用的请求头；未登录返回空对象 */
  async function authHeaders() {
    var t = await getToken();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  async function refresh() {
    if (!client) {
      currentUser = null;
      setDisplay('btnLogout', false);
      setDisplay('btnRecords', false);
      setDisplay('btnAuth', true);
      var info0 = $('userInfo');
      if (info0) info0.textContent = '未登录 · 查表免费，登录后可保存查询记录';
      return;
    }
    var res = await client.auth.getSession();
    var session = res && res.data && res.data.session;
    currentUser = (session && session.user) || null;

    setDisplay('btnAuth', !currentUser, 'inline-block');
    setDisplay('btnLogout', !!currentUser, 'inline-block');
    setDisplay('btnRecords', !!currentUser, 'inline-block');
    setDisplay('btnSaveQuery', !!currentUser && !!lastInput, 'inline-block');

    var label = $('userInfo');
    if (label) {
      if (!currentUser) {
        label.textContent = '未登录 · 查表免费，登录后可保存查询记录';
      } else {
        label.textContent = '已登录：' + (currentUser.email || '诗友');
      }
    }
    var quota = $('quotaInfo');
    if (quota && !currentUser) quota.textContent = '';
    var saveTip = $('saveTip');
    if (saveTip && !currentUser && !savedForInput) {
      saveTip.textContent = '匿名查询不保存记录；登录后可保存入数据库，随时回看';
      saveTip.className = '';
    }
    if (currentUser) loadQuota();
  }

  /** 调用 SQL 函数 ai_usage_today() 显示今日 AI 赏析用量；按北京时间自然日重置 */
  async function loadQuota() {
    if (!client || !currentUser) return;
    try {
      var res = await client.rpc('ai_usage_today');
      var data = res && res.data;
      if (data) {
        currentTier = data.quota >= DAILY_QUOTA ? 'member' : 'free';
      }
      var node = $('quotaInfo');
      if (node && data) {
        var label = currentTier === 'member' ? '会员' : '免费';
        node.textContent = label + ' · AI 赏析剩余 ' + data.remaining + '/' + data.quota;
      }
    } catch (e) {
      /* 配额显示是锦上添花，失败就算了 */
    }
  }

  // ---------------------------------------------------------------- 会员 / 二维码

  /** 是否有效会员（tier=member 且未过期） */
  function isMember() {
    if (currentTier !== 'member') return false;
    if (!memberExpiresAt) return true;
    return new Date(memberExpiresAt).getTime() > Date.now();
  }

  function openQr(title, sub, tipMsg) {
    if ($('qrTitle') && title) $('qrTitle').textContent = title;
    if ($('qrSub') && sub) $('qrSub').textContent = sub;
    var t = $('qrTip');
    if (t) t.textContent = tipMsg || '';
    setDisplay('qrModal', true, 'flex');
  }
  function closeQr() {
    setDisplay('qrModal', false);
  }

  // ---------------------------------------------------------------- 查询记录面板 状态管理
  //
  // 「查询记录」按钮的文案要随时反映面板的开/关状态，且面板可能被多处
  // 触发开关（按钮点击、保存后自动打开、退出登录时关闭），
  // 所以统一走 showRecords()，不在别处直接改 style.display。

  function recordsOpen() {
    var card = $('recordsCard');
    return !!card && card.style.display === 'block';
  }

  /** 同步按钮文案：开启时「收起查询记录」，关闭时「查询记录」 */
  function setRecordsBtn(open) {
    var btn = $('btnRecords');
    if (btn) btn.textContent = open ? '收起查询记录' : '查询记录';
  }

  /** 开 / 关查询记录面板（唯一入口，按钮文案随之更新） */
  function showRecords(show) {
    var card = $('recordsCard');
    if (card) card.style.display = show ? 'block' : 'none';
    setRecordsBtn(show);
  }

  /** 把查询记录面板滚进视口（打开时调用） */
  function scrollToRecords() {
    var card = $('recordsCard');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------- 登录 / 注册

  function openModal() {
    setDisplay('authModal', true, 'flex');
    var pwd = $('authPassword');
    if (pwd) pwd.value = '';
    tip('');
  }

  /** 打开登录框，可带一句场景化说明（如保存记录、AI 赏析需要登录） */
  function openLogin(tipMsg) {
    setMode('signin');
    openModal();
    tip(tipMsg || '登录后查询记录可保存入数据库，便于后续浏览。', false);
  }
  function closeModal() {
    setDisplay('authModal', false);
  }
  window.closeAuthModal = closeModal;

  function setMode(next) {
    mode = next;
    var isSignIn = mode === 'signin';
    if ($('authTitle')) $('authTitle').textContent = isSignIn ? '登录' : '注册';
    var note = $('authQuotaNote');
    if (note) {
      note.textContent = (isSignIn ? '登录后' : '注册后') +
        '查询记录可保存；AI 平仄分析 / 诗词鉴赏每日免费 3 次，会员 ' + DAILY_QUOTA + ' 次';
    }
    if ($('authSubmit')) $('authSubmit').textContent = isSignIn ? '登　录' : '注　册';
    if ($('authSwitch')) $('authSwitch').textContent = isSignIn ? '没有账号？去注册' : '已有账号？去登录';
  }

  function prettyError(error) {
    if (!error) return '操作失败，请重试';
    var msg = error.message || String(error);
    // Supabase 的错误是英文的，这里给几条常见的换成人话
    if (/Invalid login credentials/i.test(msg)) return '邮箱或密码不对';
    if (/Email not confirmed/i.test(msg)) return '邮箱还没确认，请先查收确认邮件';
    if (/User already registered/i.test(msg)) return '这个邮箱已经注册过了，直接登录吧';
    if (/Password should be at least/i.test(msg)) return '密码太短了，至少 6 位';
    if (/Unable to validate email/i.test(msg)) return '邮箱格式不对';
    return msg;
  }

  async function submitAuth() {
    var email = ($('authEmail') || {}).value || '';
    var password = ($('authPassword') || {}).value || '';
    if (!email.trim() || !password) return tip('邮箱和密码都得填', true);
    if (password.length < 8) return tip('密码至少 8 位', true);
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return tip('密码要同时包含字母和数字', true);
    }

    var btn = $('authSubmit');
    if (btn) btn.disabled = true;
    tip('处理中…');
    try {
      var payload = { email: email.trim(), password: password };

      if (mode === 'signup') {
        // 不走 Supabase 自带 signUp：那会发确认邮件，而默认 SMTP 限 2 封/小时，
        // 用户会卡在 over_email_send_rate_limit 上连账号都建不起来。
        // 改由我们自己的后端用 service_role 建号并直接标记为已确认，全程不发邮件。
        var r = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok) return tip(data.error || '注册失败，请稍后重试', true);
        // 注册成功后再用同一组凭据登录一次，拿到 session
        var signin = await client.auth.signInWithPassword(payload);
        if (signin.error) return tip(prettyError(signin.error), true);
        closeModal();
        await refresh();
        return;
      }

      var res = await client.auth.signInWithPassword(payload);
      if (res.error) return tip(prettyError(res.error), true);
      closeModal();
      await refresh();
    } catch (e) {
      tip('网络异常：' + (e && e.message ? e.message : e), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function signOut() {
    if (client) await client.auth.signOut();
    currentUser = null;
    lastInput = '';
    lastResult = null;
    savedForInput = '';
    currentQueryId = null;
    showRecords(false);
    await refresh();
  }

  // ---------------------------------------------------------------- 查询记录（queries 表）

  /**
   * 插入一条查询记录（只做插入，不碰 UI）。
   * saveQuery 与「AI 结果入库前的自动保存」共用，避免两处各写一份入库逻辑。
   * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
   */
  async function insertQueryRow(input, result) {
    var res = await client
      .from('queries')
      .insert({
        user_id: currentUser.id,
        input_text: String(input).slice(0, 1000),
        result: result,
      })
      .select('id')
      .single();
    if (res.error) return { ok: false, error: prettyError(res.error) };
    return { ok: true, id: res.data && res.data.id };
  }

  /**
   * 确保「当前这次查询」在库里有对应记录，返回 query_id；没有就静默插一条。
   *
   * AI 赏析结果挂在外键 query_id 上，所以用户从没点过「保存本次查询」时，
   * 也要先给他这次查询落一条记录，AI 内容才有地方存 —— 否则会出现
   * 「AI 生成成功但查询记录里查不到」。静默插入不弹提示、不强制开面板。
   */
  async function ensureQuerySaved() {
    if (!READY || !currentUser || !lastInput || !lastResult || !lastResult.ok) return null;
    if (currentQueryId && savedForInput === lastInput) return currentQueryId;
    var r = await insertQueryRow(lastInput, lastResult);
    if (!r.ok) return null;
    currentQueryId = r.id;
    savedForInput = lastInput;
    return r.id;
  }

  /**
   * 保存本次查询记录（input_text + 查表结果 jsonb）。
   * 表上 RLS：本人可读 / 本人可建 / 本人可删，无 UPDATE —— 记录不可篡改。
   */
  async function saveQuery() {
    if (!READY) {
      var off = $('saveTip');
      if (off) { off.textContent = '账号功能未启用，暂不能保存查询记录'; off.className = ''; }
      return;
    }
    if (!currentUser) {
      openLogin('登录后查询记录可保存入数据库，便于后续浏览。');
      return;
    }
    if (!lastInput || !lastResult || !lastResult.ok) return;

    var btn = $('btnSaveQuery');
    var node = $('saveTip');

    // 防重复入库：已为「本次查询结果」保存过就不再重复插
    if (currentQueryId && savedForInput === lastInput) {
      if (node) { node.textContent = '本次查询已保存到「查询记录」'; node.className = 'ok'; }
      return;
    }
    if (btn && btn.disabled) return;

    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    if (node) { node.textContent = ''; node.className = ''; }

    try {
      var r = await insertQueryRow(lastInput, lastResult);
      if (!r.ok) {
        if (node) { node.textContent = '保存失败：' + r.error; node.className = ''; }
        return;
      }
      currentQueryId = r.id;
      savedForInput = lastInput;
      if (node) { node.textContent = '已保存到「查询记录」✓'; node.className = 'ok'; }
      // 保存成功后自动打开「查询记录」面板并刷新内容；
      // 面板原本关着时才额外滚动过去（已开着说明用户就在面板附近，只刷内容）
      var wasOpen = recordsOpen();
      showRecords(true);
      await loadRecords();
      if (!wasOpen) scrollToRecords();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '☆ 保存本次查询'; }
    }
  }

  // ---------------------------------------------------------------- AI 赏析入库（query_insights 表）

  /**
   * AI 赏析成功后回调：把内容写进 query_insights。
   *
   * 库表（迁移 20261016094246）append-only：无 UPDATE 授权，只能增/删，
   * 与 queries 同口径。同一查询同一 kind 可有多条，展示时取最新一条。
   *
   * 入库失败绝不打扰用户：AI 内容已经显示在页面上了，存不进去只是
   * 下次回看不到，不该用报错打断这次赏析体验。
   */
  async function onAiDone(kind, content, model) {
    if (!READY || !currentUser) return null;
    if (kind !== 'analysis' && kind !== 'appreciation') return null;
    var text = String(content == null ? '' : content).trim();
    if (!text) return null;

    var qid = await ensureQuerySaved();
    if (!qid) return null;

    var res;
    try {
      res = await client
        .from('query_insights')
        .insert({
          user_id: currentUser.id,
          query_id: qid,
          kind: kind,
          content: text.slice(0, AI_CONTENT_MAX),
          model: model || null,
        })
        .select('id')
        .single();
    } catch (e) {
      return null;
    }
    if (res.error) return null;

    // 面板开着就顺手刷新，用户能立刻在记录里看到刚生成的内容
    if (recordsOpen()) loadRecords();
    return res.data && res.data.id;
  }

  /**
   * 读这些查询记录各自最新的一条 AI 赏析内容，按 query_id 归并成 Map。
   * 单独一次 in(...) 查询即可，不做逐条 N+1。
   * @param {Array<{id:string}>} rows 查询记录
   * @returns {Promise<Object<string, {analysis?:object, appreciation?:object}>>}
   */
  async function loadInsightsFor(rows) {
    var map = {};
    var ids = rows.map(function (r) { return r.id; }).filter(Boolean);
    if (!ids.length) return map;
    var res;
    try {
      res = await client
        .from('query_insights')
        .select('query_id, kind, content, model, created_at')
        .in('query_id', ids)
        .order('created_at', { ascending: false });
    } catch (e) {
      // AI 内容读不出来不影响记录列表本身（平仄结果照常看）
      return map;
    }
    if (res.error || !res.data) return map;
    (res.data || []).forEach(function (r) {
      var bucket = map[r.query_id] || (map[r.query_id] = {});
      // 已按 created_at 倒序，先到先得 → 保留的即为最新一条
      if (!bucket[r.kind]) bucket[r.kind] = r;
    });
    return map;
  }

  /** 记录卡片里折叠展示的 AI 内容块 */
  function aiBlocksHtml(bucket) {
    if (!bucket) return '';
    var order = ['analysis', 'appreciation'];
    var html = '';
    order.forEach(function (kind) {
      var it = bucket[kind];
      if (!it || !it.content) return;
      html += '<details class="hist-ai"><summary>' + AI_KIND_LABEL[kind] + '</summary>' +
        '<pre class="hist-ai-body">' + escapeHtml(it.content) + '</pre></details>';
    });
    return html;
  }

  async function loadRecords() {
    var list = $('recordsList');
    var card = $('recordsCard');
    if (!card || !list) return;

    if (!currentUser) {
      showRecords(true);
      list.innerHTML = '<span class="hint">登录后才能查看查询记录。</span>';
      return;
    }
    showRecords(true);
    list.innerHTML = '<span class="hint">载入中…</span>';

    var res;
    try {
      res = await client
        .from('queries')
        .select('id, created_at, input_text, result')
        .order('created_at', { ascending: false })
        .limit(20);
    } catch (e) {
      // 网络层异常（而非 res.error）也不能逃逸：saveQuery 里还指着这次刷新
      // 给用户反馈，抛出会把「已保存」的提示一起拖进未处理 rejection
      list.innerHTML = '<span class="hint">读取失败：网络异常，请稍后重试</span>';
      return;
    }

    if (res.error) {
      list.innerHTML = '<span class="hint">读取失败：' + prettyError(res.error) + '</span>';
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      list.innerHTML = '<span class="hint">还没有查询记录。查询后点「☆ 保存本次查询」即可收藏到这里；生成 AI 赏析也会自动保存。</span>';
      return;
    }

    // AI 赏析内容一并读出（失败也只是不显示，不影响平仄记录）
    var insightMap = await loadInsightsFor(rows);

    var html = '';
    rows.forEach(function (r) {
      var s = summarize(r.result);
      // 显示全部输入文本（不截断、不折叠换行）
      var preview = String(r.input_text || '');
      var bucket = insightMap[r.id];
      var hasAi = !!(bucket && (bucket.analysis || bucket.appreciation));
      html += '<div class="hist-item" data-id="' + r.id + '">' +
        '<div class="hist-meta">' + formatTime(r.created_at) +
        (hasAi ? '<span class="hist-ai-flag">含 AI 赏析</span>' : '') + '</div>' +
        '<div class="hist-text">' + escapeHtml(preview) + '</div>' +
        '<div class="hist-tags"><span class="tone-ping">平 ' + (s ? s.ping : 0) + '</span>' +
        '<span class="tone-ze">仄 ' + (s ? s.ze : 0) + '</span>' +
        (s && s.tong ? '<span class="tone-tong">通 ' + s.tong + '</span>' : '') +
        '<button class="mini-btn rec-del" data-act="del" title="删除这条记录">删除</button></div>' +
        aiBlocksHtml(bucket) +
        '</div>';
    });
    list.innerHTML = html;

    Array.prototype.forEach.call(list.querySelectorAll('.hist-item'), function (node) {
      var id = node.getAttribute('data-id');
      var row = rows.filter(function (x) { return x.id === id; })[0];
      if (!row) return;
      var bucket = insightMap[id];
      // 点正文：把原文载回输入框，并把当时保存的查表结果与 AI 内容重新渲染出来
      var textNode = node.querySelector('.hist-text');
      if (textNode) textNode.addEventListener('click', function () {
        var ta = $('poem');
        if (ta) ta.value = row.input_text || '';
        if (window.renderResult) window.renderResult(row.result);
        // 告诉账号系统「当前就是这条记录」：后续 AI 生成会挂回这一条，
        // 不会在库里重复插一条同名查询
        if (window.PingzeAuth) {
          window.PingzeAuth.onQueryDone(row.input_text || '', row.result, row.id);
        }
        // AI 内容回放：只填文本，不代用户勾开关（开关仍可自行打开重新生成）
        if (window.showAiRecord) {
          window.showAiRecord({
            analysis: bucket && bucket.analysis ? bucket.analysis.content : '',
            appreciation: bucket && bucket.appreciation ? bucket.appreciation.content : '',
          });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      var del = node.querySelector('[data-act="del"]');
      if (del) del.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteRecord(row.id);
      });
    });
  }

  async function deleteRecord(id) {
    if (!confirm('确定删除这条查询记录？此操作不可恢复。')) return;
    var res;
    try {
      res = await client.from('queries').delete().eq('id', id);
    } catch (e) {
      alert('删除失败：网络异常，请稍后重试');
      return;
    }
    if (res.error) {
      alert('删除失败：' + prettyError(res.error));
      return;
    }
    // 如果刚删的正是当前结果区展示的那条保存记录，重置防重复标记
    if (currentQueryId === id) {
      currentQueryId = null;
      savedForInput = '';
    }
    if (recordsOpen()) loadRecords();
  }

  // ---------------------------------------------------------------- 对外接口

  window.PingzeAuth = {
    ready: READY,
    client: client,
    /** 给 fetch 用的鉴权头 */
    authHeaders: authHeaders,
    getUser: function () {
      return currentUser;
    },
    /** 每次查询完成后由 index.html 回调
     *  @param {string} input
     *  @param {object} result
     *  @param {string} [queryId] 回放已有记录时传入其 id：
     *        这样后续 AI 生成会挂回这条记录，而不是重复插一条查询。 */
    onQueryDone: function (input, result, queryId) {
      lastInput = input || '';
      lastResult = result || null;
      // 换了新的查询结果 -> 重新允许「保存本次查询」
      if (lastInput !== savedForInput || (queryId && queryId !== currentQueryId)) {
        currentQueryId = queryId || null;
        savedForInput = queryId ? lastInput : '';
        var tipNode = $('saveTip');
        if (tipNode && currentUser) {
          tipNode.textContent = queryId ? '这条记录已在「查询记录」中 ✓' : '';
          tipNode.className = queryId ? 'ok' : '';
        }
      }
      setDisplay('btnSaveQuery', !!currentUser && !!lastInput, 'inline-block');
      if (currentUser) loadQuota();
      // 面板正开着的话要立刻把这条新记录刷进去
      if (currentUser && recordsOpen()) loadRecords();
    },
    /** 保存本次查询记录（未登录会先弹登录框） */
    saveQuery: saveQuery,
    /** AI 赏析生成成功后回调：内容入库（内部先确保查询记录已存在） */
    onAiDone: onAiDone,
    openLogin: openLogin,
    /** 会员/配额状态 */
    isMember: isMember,
    getTier: function () { return currentTier; },
    openUpgradeQr: openQr,
    closeUpgradeQr: closeQr,
    loadQuota: loadQuota,
    refresh: refresh,
    /** 刷新「查询记录」列表 */
    loadRecords: loadRecords,
  };

  // ---------------------------------------------------------------- 初始化

  function wire() {
    if ($('btnAuth')) $('btnAuth').addEventListener('click', function () {
      openLogin();
    });
    if ($('btnLogout')) $('btnLogout').addEventListener('click', signOut);
    if ($('btnRecords')) $('btnRecords').addEventListener('click', async function () {
      if (recordsOpen()) {
        // 已开着 → 点击收起
        showRecords(false);
        return;
      }
      // 关着 → 打开、载入并滚动到面板所在位置
      await loadRecords();
      scrollToRecords();
    });
    if ($('btnSaveQuery')) $('btnSaveQuery').addEventListener('click', saveQuery);
    if ($('authSubmit')) $('authSubmit').addEventListener('click', submitAuth);
    if ($('authSwitch')) $('authSwitch').addEventListener('click', function () {
      setMode(mode === 'signin' ? 'signup' : 'signin');
    });
    if ($('authClose')) $('authClose').addEventListener('click', closeModal);
    if ($('qrClose')) $('qrClose').addEventListener('click', closeQr);
    if ($('qrModal')) {
      $('qrModal').addEventListener('click', function (e) {
        if (e.target === $('qrModal')) closeQr();
      });
    }
    if ($('authModal')) {
      $('authModal').addEventListener('click', function (e) {
        if (e.target === $('authModal')) closeModal();
      });
    }
    var pwd = $('authPassword');
    if (pwd) pwd.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitAuth();
    });

    if (!READY) {
      var banner = $('authDisabledTip');
      if (banner) banner.style.display = 'block';
    }
    setRecordsBtn(recordsOpen()); // 面板初始隐藏 → 按钮显示「查询记录」
    setMode('signin');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      wire();
      refresh();
    });
  } else {
    wire();
    refresh();
  }

  if (client) {
    client.auth.onAuthStateChange(function () {
      refresh();
    });
  }
})();
