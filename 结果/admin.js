/**
 * 平仄查询站 · 管理后台前端
 *
 * 依赖顺序（在 admin.html 中）：supabase UMD → supabase-config.js → 本文件
 * 复用与首页相同的 Supabase 项目（window.PINGZE_SUPABASE）。
 *
 * 权限模型（务必牢记）：前端只做体验层，真正的鉴权在服务端
 *   /api/admin-users 会用 service_role 调 /auth/v1/user 重新校验 JWT，
 *   并比对 ADMIN_EMAILS 白名单，非管理员一律返回 403，前端拿不到任何数据。
 */
/* global supabase */
(function () {
  'use strict';

  var CFG = window.PINGZE_SUPABASE || {};
  var READY =
    Boolean(CFG.url && CFG.anonKey) &&
    /^https?:\/\//.test(CFG.url) &&
    window.supabase &&
    typeof window.supabase.createClient === 'function';

  var client = READY
    ? window.supabase.createClient(CFG.url, CFG.anonKey, {
        // 后台安全要求：每次进入都必须重新登录 —— 不持久化会话、不自动续期。
        // 因此这里刻意关掉 persistSession 与 autoRefreshToken，与首页的配置不同。
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

  function $(id) { return document.getElementById(id); }
  function show(id) { var n = $(id); if (n) n.style.display = ''; }
  function hide(id) { var n = $(id); if (n) n.style.display = 'none'; }

  function tip(msg, isErr) {
    var n = $('adminTip');
    if (!n) return;
    n.textContent = msg || '';
    n.className = isErr ? 'tip err' : 'tip';
  }

  async function getToken() {
    if (!client) return null;
    try {
      var s = await client.auth.getSession();
      return s && s.data && s.data.session ? s.data.session.access_token : null;
    } catch (e) { return null; }
  }

  function prettyError(e) {
    if (!e) return '操作失败，请重试';
    var m = e.message || String(e);
    if (/Invalid login credentials/i.test(m)) return '邮箱或密码不对';
    if (/Email not confirmed/i.test(m)) return '邮箱还没确认';
    if (/Unable to validate email/i.test(m)) return '邮箱格式不对';
    return m;
  }

  function fmt(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function login() {
    var email = ($('adminEmail').value || '').trim();
    var pwd = $('adminPassword').value || '';
    if (!email || !pwd) return tip('邮箱和密码都得填', true);
    $('adminSubmit').disabled = true;
    tip('登录中…');
    try {
      var r = await client.auth.signInWithPassword({ email: email, password: pwd });
      if (r.error) { tip(prettyError(r.error), true); return; }
      // 登录成功不代表是管理员，立刻拉一次后台数据来确认身份
      await loadDashboard();
    } catch (e) {
      tip('网络异常：' + (e && e.message ? e.message : e), true);
    } finally {
      $('adminSubmit').disabled = false;
    }
  }

  async function loadDashboard() {
    var token = await getToken();
    if (!token) { showLogin(); tip('会话已失效，请重新登录', true); return; }
    tip('载入中…');
    try {
      var res = await fetch('/api/admin-users', { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 403) {
        var d = await res.json().catch(function () { return {}; });
        await client.auth.signOut().catch(function () {});
        showLogin();
        tip('当前账号不是管理员，无权限访问后台。' + (d.reason ? '（' + d.reason + '）' : ''), true);
        return;
      }
      if (!res.ok) { showLogin(); tip('读取失败（HTTP ' + res.status + '）', true); return; }
      var data = await res.json();
      renderUsers(data.users || []);
      showDash();
      $('adminMeta').textContent = '共 ' + (data.count || 0) + ' 个用户';
      tip('');
    } catch (e) {
      showLogin();
      tip('网络异常：' + (e && e.message ? e.message : e), true);
    }
  }

  /** 会员倒计时文案：剩余天数 <5 天时用红色（.days-near） */
  function renderCountdown(u) {
    if (!u.member_expires_at) return '<span class="muted">—</span>';
    var left = u.member_days_left;
    if (left === null || left === undefined) return '<span class="muted">—</span>';
    var expText = '到期 ' + (String(u.member_expires_at).slice(0, 10));
    if (left < 0) {
      return '<span class="days-expired">已过期 ' + Math.abs(left) + ' 天</span>' +
        '<div class="muted" style="font-size:12px">' + expText + '</div>';
    }
    var cls = left < 5 ? 'days-near' : 'days-ok';
    return '<span class="' + cls + '">剩余 ' + left + ' 天</span>' +
      '<div class="muted" style="font-size:12px">' + expText + '</div>';
  }

  function renderUsers(users) {
    var tbody = $('userRows');
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="muted">暂无用户</td></tr>';
      return;
    }
    var html = '';
    users.forEach(function (u) {
      var isMember = u.member_active === true;
      var badge = isMember
        ? '<span class="badge member">会员</span>'
        : (u.tier === 'member'
            ? '<span class="badge free">会员(已过期)</span>'
            : '<span class="badge free">免费</span>');
      html += '<tr data-uid="' + esc(u.id) + '">' +
        '<td>' + esc(u.email) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + renderCountdown(u) + '</td>' +
        '<td>' + fmt(u.created_at) + '</td>' +
        '<td>' + fmt(u.last_sign_in_at) + '</td>' +
        '<td>' + (u.confirmed_at ? '<span class="ok">已确认</span>' : '<span class="warn">未确认</span>') + '</td>' +
        '<td>' + esc(u.provider || 'email') + '</td>' +
        '<td>' + (u.analysis_count || 0) + '</td>' +
        '<td>' + (u.api_count || 0) + '</td>' +
        '<td><button class="ghost tier-btn" data-uid="' + esc(u.id) + '" ' +
            'data-tier="' + esc(u.tier || 'free') + '" ' +
            'data-email="' + esc(u.email) + '">改等级</button></td>' +
      '</tr>';
    });
    tbody.innerHTML = html;

    Array.prototype.forEach.call(tbody.querySelectorAll('.tier-btn'), function (btn) {
      btn.addEventListener('click', function () {
        changeTier(btn.getAttribute('data-uid'),
                   btn.getAttribute('data-tier'),
                   btn.getAttribute('data-email'));
      });
    });
  }

  /**
   * 修改会员等级（运营人操作）。
   * 会员按月计费、30 天；已是会员则续费顺延。
   */
  async function changeTier(uid, currentTier, email) {
    var isMember = currentTier === 'member';
    var action = isMember ? '降级为「免费用户」' : '开通「会员」（30 天）';
    if (!confirm('确定要把 ' + email + ' ' + action + ' 吗？')) return;

    var token = await getToken();
    if (!token) { showLogin(); tip('会话已失效，请重新登录', true); return; }
    var nextTier = isMember ? 'free' : 'member';
    try {
      var res = await fetch('/api/admin-set-tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ userId: uid, tier: nextTier, days: 30 }),
      });
      var d = await res.json().catch(function () { return {}; });
      if (!res.ok) { alert('操作失败：' + (d.error || ('HTTP ' + res.status))); return; }
      await loadDashboard(); // 重新拉取，倒计时等一并刷新
    } catch (e) {
      alert('网络异常：' + (e && e.message ? e.message : e));
    }
  }

  function showLogin() {
    show('adminLogin');
    hide('adminDash');
    hide('adminLogoutTop');
  }

  function showDash() {
    hide('adminLogin');
    show('adminDash');
    show('adminLogoutTop');
  }

  async function logout() {
    if (client) await client.auth.signOut().catch(function () {});
    showLogin();
    tip('');
    $('adminMeta').textContent = '';
    $('adminPassword').value = '';
    // 清空列表，避免退出后残留在 DOM 里被看到
    var tb = $('userRows');
    if (tb) tb.innerHTML = '';
  }

  function init() {
    if (!READY) {
      showLogin();
      tip('后台未配置 Supabase（缺少 PINGZE_SUPABASE 或 supabase UMD 未加载）。', true);
      return;
    }
    // 「每次进入都必须重新登录」：先强制登出，清掉可能残留的会话，再显示登录框。
    // 不能用 getSession() 判断 —— 那样会把上次的会话直接放进来。
    Promise.resolve()
      .then(function () { return client.auth.signOut(); })
      .catch(function () {})
      .then(function () { showLogin(); });
  }

  function wire() {
    if ($('adminSubmit')) $('adminSubmit').addEventListener('click', login);
    if ($('adminPassword')) $('adminPassword').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') login();
    });
    if ($('adminLogout')) $('adminLogout').addEventListener('click', logout);
    if ($('adminLogoutTop')) $('adminLogoutTop').addEventListener('click', logout);
    if ($('adminRefresh')) $('adminRefresh').addEventListener('click', loadDashboard);
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
