/**
 * 平仄查询站 · Supabase 前端集成
 *
 * 依赖顺序（在 index.html 中）：
 *   supabase UMD → supabase-config.js → 本文件
 *
 * 降级原则：只要配置缺失或 CDN 没加载成功，整套登录功能静默关闭，
 * 原有的「匿名分析」链路必须照常可用 —— 不能因为接了账号系统就把站搞挂。
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
  var currentPoemId = null;
  // 已经「保存为作品」过的输入文本；用于防止对同一次分析结果重复入库
  var savedForInput = '';
  // 会员/配额状态（由 usage_today() 与后端 429 回包更新）
  var currentTier = 'free';
  var memberExpiresAt = null;
  // 本次会话里「成功完成的分析次数」——用于免费用户第 2 次分析时弹二维码。
  // 只在真实分析成功时自增（缓存命中也算一次可见结果，一并计入）。
  var sessionAnalyses = 0;

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
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function summarize(data) {
    if (!data || !Array.isArray(data.chars)) return null;
    var ping = 0, ze = 0, tong = 0;
    data.chars.forEach(function (c) {
      if (c.tone === '平') ping++;
      else if (c.tone === '仄') ze++;
      else if (c.tone === '通') tong++;
    });
    return { ping: ping, ze: ze, tong: tong, form: data.form || null };
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

  /** 给 /api/analyze 用的请求头；未登录返回空对象 */
  async function authHeaders() {
    var t = await getToken();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  async function refresh() {
    if (!client) {
      currentUser = null;
      setDisplay('btnLogout', false);
      setDisplay('btnHistory', false);
      setDisplay('btnAuth', true);
      var info = $('userInfo');
      if (info) info.textContent = '未登录 · 分析功能需先登录';
      return;
    }
    var res = await client.auth.getSession();
    var session = res && res.data && res.data.session;
    currentUser = (session && session.user) || null;

    setDisplay('btnAuth', !currentUser, 'inline-block');
    setDisplay('btnLogout', !!currentUser, 'inline-block');
    setDisplay('btnHistory', !!currentUser, 'inline-block');
    setDisplay('btnWorks', !!currentUser, 'inline-block');
    setDisplay('btnSavePoem', !!currentUser && !!lastInput, 'inline-block');

    var label = $('userInfo');
    if (label) {
      if (!currentUser) {
        label.textContent = '未登录 · 分析功能需先登录';
      } else {
        label.textContent = '已登录：' + (currentUser.email || '诗友');
      }
    }
    if (currentUser) loadQuota();
  }

  /** 调用 SQL 函数 usage_today() 显示今日用量；配额按北京时间自然日重置 */
  async function loadQuota() {
    if (!client) return;
    try {
      var res = await client.rpc('usage_today');
      var data = res && res.data;
      if (data) {
        currentTier = data.tier || 'free';
        memberExpiresAt = data.member_expires_at || null;
      }
      var node = $('quotaInfo');
      if (node && data) {
        var label = currentTier === 'member' ? '会员' : '免费';
        node.textContent = label + '· 今日用量 ' + data.used + '/' + data.quota +
          '（剩余 ' + data.remaining + '，缓存命中不计费）';
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

  /**
   * 在「开始一次分析之前」决定是否要拦下来弹二维码。
   * 规则：免费用户今天已经用过 ≥1 次（或本会话已分析过 ≥1 次），再点分析就弹二维码。
   *
   * 以服务端 usage_today() 的 used 为准（防刷新页面绕过），本会话计数作兜底。
   * 返回 true 表示已弹出、调用方应中断本次分析。
   */
  async function maybePromptUpgrade() {
    if (!currentUser) return false;
    if (isMember()) return false;

    var used = sessionAnalyses;
    try {
      var res = await client.rpc('usage_today');
      if (res && res.data) {
        if (typeof res.data.used === 'number') used = Math.max(used, res.data.used);
        currentTier = res.data.tier || currentTier;
        memberExpiresAt = res.data.member_expires_at || memberExpiresAt;
        if (isMember()) return false; // 刚变成会员就不拦
      }
    } catch (e) { /* 查询失败就用本地计数兜底 */ }

    if (used < 1) return false;
    openQr(
      '开通会员',
      '免费用户每天可分析 1 次，会员每天 10 次',
      '支付后请联系运营人开通，开通后刷新本页即可。'
    );
    return true;
  }

  // ---------------------------------------------------------------- 登录 / 注册

  function openModal() {
    setDisplay('authModal', true, 'flex');
    var pwd = $('authPassword');
    if (pwd) pwd.value = '';
    tip('');
  }

  /**
   * 执行分析前调用：未登录就弹登录框并返回 false，让调用方直接中断。
   *
   * 认证没配置好（READY=false）时不拦 —— 那种情况下拦了等于整站不可用。
   * 注意这只是体验层拦截，真正的强制在后端（/api/analyze 会返回 401）。
   */
  async function requireLogin() {
    if (!READY) return true;
    // session 可能刚好过期，先刷新一次再判断，别拿旧状态放行
    if (!currentUser) await refresh();
    if (currentUser) return true;
    setMode('signin');
    openModal();
    tip('分析功能需要先登录。注册后立即可用，每日 ' + DAILY_QUOTA + ' 次额度。', false);
    return false;
  }
  function closeModal() {
    setDisplay('authModal', false);
  }
  window.closeAuthModal = closeModal;

  /** 额度说明。真正的额度来自后端与数据库 usage_today()：
   *  免费用户每日 1 次、会员每日 10 次（见 supabase/0006_membership.sql）。 */
  var DAILY_QUOTA = 10;

  function setMode(next) {
    mode = next;
    var isSignIn = mode === 'signin';
    if ($('authTitle')) $('authTitle').textContent = isSignIn ? '登录' : '注册';
    var note = $('authQuotaNote');
    if (note) {
      note.textContent = (isSignIn ? '登录后' : '注册后') +
        '每日可免费分析 1 次；开通会员每日可分析 ' + DAILY_QUOTA + ' 次';
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
    currentPoemId = null;
    setDisplay('historyCard', false);
    setDisplay('worksCard', false);
    await refresh();
  }

  // ---------------------------------------------------------------- 我的分析

  async function loadHistory() {
    var list = $('historyList');
    var card = $('historyCard');
    if (!card || !list) return;

    if (!currentUser) {
      card.style.display = 'block';
      list.innerHTML = '<span class="hint">登录后才能查看自己的分析记录。</span>';
      return;
    }
    card.style.display = 'block';
    list.innerHTML = '<span class="hint">载入中…</span>';

    var res = await client
      .from('analyses')
      .select('id, created_at, input_text, result, summary')
      .order('created_at', { ascending: false })
      .limit(20);

    if (res.error) {
      list.innerHTML = '<span class="hint">读取失败：' + prettyError(res.error) + '</span>';
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      list.innerHTML = '<span class="hint">还没有分析记录。分析一次诗词后就会出现在这里。</span>';
      return;
    }

    var html = '';
    rows.forEach(function (r) {
      var s = summarize(r.result) || summarize({ chars: [] });
      // 显示全部输入文本（不截断、不折叠换行）
      var preview = String(r.input_text || '');
      html += '<div class="hist-item" data-id="' + r.id + '">' +
        '<div class="hist-meta">' + formatTime(r.created_at) +
        (s.form ? ' · ' + escapeHtml(s.form) : '') + '</div>' +
        '<div class="hist-text">' + escapeHtml(preview) + '</div>' +
        '<div class="hist-tags"><span class="tone-ping">平 ' + s.ping + '</span>' +
        '<span class="tone-ze">仄 ' + s.ze + '</span>' +
        (s.tong ? '<span class="tone-tong">通 ' + s.tong + '</span>' : '') + '</div>' +
        '</div>';
    });
    list.innerHTML = html;

    Array.prototype.forEach.call(list.querySelectorAll('.hist-item'), function (node) {
      node.addEventListener('click', function () {
        var row = rows.filter(function (x) { return x.id === node.getAttribute('data-id'); })[0];
        if (!row) return;
        var ta = $('poem');
        if (ta) ta.value = row.input_text || '';
        if (row.result && typeof window.renderResult === 'function') {
          window.renderResult(row.result);
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ---------------------------------------------------------------- 保存作品

  async function savePoem() {
    if (!currentUser) return openModal();
    if (!lastInput) return;

    var btn = $('btnSavePoem');
    var node = $('saveTip');

    // 防重复入库：已为「本次分析结果」保存过就不再重复插
    if (currentPoemId && savedForInput === lastInput) {
      if (node) { node.textContent = '本次结果已保存到「我的作品」'; node.className = 'ok'; }
      return;
    }
    if (btn && btn.disabled) return;

    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    if (node) { node.textContent = ''; node.className = ''; }

    // 自动取首句当标题：截到第一个标点为止
    var raw = lastInput.replace(/[\r\n]+/g, ' ').trim();
    var firstCut = raw.split(/[，。；！？、,.!?;:\s]/)[0];
    var title = (firstCut || raw).slice(0, 40) || '无题';

    try {
      var res = await client
        .from('poems')
        .insert({
          user_id: currentUser.id,
          title: title,
          body: lastInput.slice(0, 1000),
          form: (lastResult && lastResult.form) || null,
          origin: 'original',
        })
        .select('id')
        .single();

      if (res.error) {
        if (node) { node.textContent = '保存失败：' + prettyError(res.error); node.className = ''; }
        return;
      }
      currentPoemId = res.data && res.data.id;
      savedForInput = lastInput;
      if (node) { node.textContent = '已保存到「我的作品」✓'; node.className = 'ok'; }
      // 保存状态保持常驻，不再自动清空：用户可能隔一会儿才回来看是否存上了。
      // 下一次分析（onAnalysisDone 换新文本）会统一重置。
      // 若「我的作品」面板正开着，把这条新保存的也刷进去
      var wcard = $('worksCard');
      if (wcard && wcard.style.display === 'block') loadWorks();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '☆ 保存为作品'; }
    }
  }

  // ---------------------------------------------------------------- 我的作品

  var editingId = null;

  async function loadWorks() {
    var list = $('worksList');
    var card = $('worksCard');
    if (!card || !list) return;

    if (!currentUser) {
      card.style.display = 'block';
      list.innerHTML = '<span class="hint">登录后才能查看自己的作品。</span>';
      return;
    }
    card.style.display = 'block';
    list.innerHTML = '<span class="hint">载入中…</span>';

    var res = await client
      .from('poems')
      .select('id, title, body, form, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50);

    if (res.error) {
      list.innerHTML = '<span class="hint">读取失败：' + prettyError(res.error) + '</span>';
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      list.innerHTML = '<span class="hint">还没有作品。分析完一首诗后点「保存为作品」即可收藏到这里。</span>';
      return;
    }

    var html = '';
    rows.forEach(function (r) {
      // 显示全部正文（不截断、不折叠换行）
      var preview = String(r.body || '');
      html += '<div class="work-item" data-id="' + r.id + '">' +
        '<div class="work-main">' +
          '<div class="work-title">' + escapeHtml(r.title || '无题') +
            (r.form ? '<span class="work-form">' + escapeHtml(r.form) + '</span>' : '') + '</div>' +
          '<div class="work-text">' + escapeHtml(preview) + '</div>' +
          '<div class="hist-meta">更新于 ' + formatTime(r.updated_at || r.created_at) + '</div>' +
        '</div>' +
        '<div class="work-actions">' +
          '<button class="mini-btn" data-act="edit">编辑</button>' +
          '<button class="mini-btn" data-act="del">删除</button>' +
        '</div>' +
      '</div>';
    });
    list.innerHTML = html;

    Array.prototype.forEach.call(list.querySelectorAll('.work-item'), function (node) {
      var id = node.getAttribute('data-id');
      var row = rows.filter(function (x) { return x.id === id; })[0];
      if (!row) return;
      // 点正文区：把作品载回上方输入框，便于重新分析
      node.querySelector('.work-main').addEventListener('click', function () {
        var ta = $('poem');
        if (ta) ta.value = row.body || '';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      node.querySelector('[data-act="edit"]').addEventListener('click', function (e) {
        e.stopPropagation();
        openEditModal(row);
      });
      node.querySelector('[data-act="del"]').addEventListener('click', function (e) {
        e.stopPropagation();
        deletePoem(row);
      });
    });
  }

  function openEditModal(row) {
    editingId = row.id;
    if ($('workEditTitle')) $('workEditTitle').value = row.title || '';
    if ($('workEditBody')) $('workEditBody').value = row.body || '';
    if ($('workEditForm')) $('workEditForm').value = row.form || '';
    var tipNode = $('workEditTip');
    if (tipNode) tipNode.textContent = '';
    setDisplay('worksModal', true, 'flex');
  }
  function closeEditModal() {
    editingId = null;
    setDisplay('worksModal', false);
  }

  async function saveEdit() {
    if (!editingId) return;
    var title = (($('workEditTitle') || {}).value || '').trim();
    var body = (($('workEditBody') || {}).value || '').trim();
    var form = (($('workEditForm') || {}).value || '').trim();
    if (!body) {
      var t = $('workEditTip');
      if (t) t.textContent = '正文不能为空';
      return;
    }
    var tipNode = $('workEditTip');
    if (tipNode) tipNode.textContent = '保存中…';
    var res = await client
      .from('poems')
      .update({
        title: (title || body.split(/[，。；！？、,.!?;:\s]/)[0] || '无题').slice(0, 60),
        body: body.slice(0, 1000),
        form: form || null,
      })
      .eq('id', editingId);
    if (res.error) {
      if (tipNode) tipNode.textContent = '保存失败：' + prettyError(res.error);
      return;
    }
    closeEditModal();
    // 保存成功后刷新列表（更新时间会变化，需重读）
    var card = $('worksCard');
    if (card && card.style.display === 'block') loadWorks();
  }

  async function deletePoem(row) {
    if (!confirm('确定删除《' + (row.title || '无题') + '》？此操作不可恢复。')) return;
    var res = await client.from('poems').delete().eq('id', row.id);
    if (res.error) {
      alert('删除失败：' + prettyError(res.error));
      return;
    }
    var card = $('worksCard');
    if (card && card.style.display === 'block') loadWorks();
  }

  // ---------------------------------------------------------------- 对外接口

  window.PingzeAuth = {
    ready: READY,
    client: client,
    /** 给 fetch 用的鉴权头 */
    authHeaders: authHeaders,
    /** 后端用来把这次分析挂到作品上 */
    getPoemId: function () {
      return currentPoemId;
    },
    getUser: function () {
      return currentUser;
    },
    /** 每次分析完成后由 index.html 回调 */
    onAnalysisDone: function (input, result) {
      lastInput = input || '';
      lastResult = result || null;
      // 换了新的分析结果 -> 视为一件新作品，重新允许「保存为作品」
      if (lastInput !== savedForInput) {
        currentPoemId = null;
        savedForInput = '';
        var tip = $('saveTip');
        if (tip) { tip.textContent = ''; tip.className = ''; }
      }
      sessionAnalyses += 1; // 供 maybePromptUpgrade 判断「第 2 次」
      setDisplay('btnSavePoem', !!currentUser && !!lastInput, 'inline-block');
      if (currentUser) loadQuota();
      // 面板正开着的话要立刻把这条新记录刷进去。
      // 后端是写库成功后才返回结果的，所以这里查一定能查到。
      var card = $('historyCard');
      if (currentUser && card && card.style.display === 'block') loadHistory();
    },
    openLogin: openModal,
    /** 分析前调用：未登录会弹登录框并返回 false */
    requireLogin: requireLogin,
    /**
     * 分析开始前的会员拦截：免费用户第 2 次分析返回 true（已弹二维码）。
     * 注意这只是体验层，真正的额度强制在后端（超额返回 429）。
     */
    shouldBlockForUpgrade: maybePromptUpgrade,
    /** 会员/配额状态 */
    isMember: isMember,
    getTier: function () { return currentTier; },
    openUpgradeQr: openQr,
    closeUpgradeQr: closeQr,
    refresh: refresh,
    /** 刷新「我的作品」列表（面板开着时由 savePoem 回调） */
    loadWorks: loadWorks,
  };

  // ---------------------------------------------------------------- 初始化

  function wire() {
    if ($('btnAuth')) $('btnAuth').addEventListener('click', function () {
      setMode('signin');
      openModal();
    });
    if ($('btnLogout')) $('btnLogout').addEventListener('click', signOut);
    if ($('btnHistory')) $('btnHistory').addEventListener('click', function () {
      var card = $('historyCard');
      if (card && card.style.display === 'block') {
        card.style.display = 'none';
      } else {
        loadHistory();
      }
    });
    if ($('btnSavePoem')) $('btnSavePoem').addEventListener('click', savePoem);
    if ($('btnWorks')) $('btnWorks').addEventListener('click', function () {
      var card = $('worksCard');
      if (card && card.style.display === 'block') {
        card.style.display = 'none';
      } else {
        loadWorks();
      }
    });
    if ($('workEditSave')) $('workEditSave').addEventListener('click', saveEdit);
    if ($('workEditCancel')) $('workEditCancel').addEventListener('click', closeEditModal);
    if ($('worksModal')) {
      $('worksModal').addEventListener('click', function (e) {
        if (e.target === $('worksModal')) closeEditModal();
      });
    }
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
