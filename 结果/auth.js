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
 * 2026-10-20 新增「修改密码」：
 *   · userbar 的 #btnPwd 仅登录态显示；弹层 pwdMode=change 时先验旧密码再改；
 *   · 登录框 #authForgot 走 resetPasswordForEmail 发重置邮件；
 *   · pwdMode=recover 处理邮件链接落地（PASSWORD_RECOVERY 事件 / URL type=recovery）。
 *     ★ 此模式下弹层是**锁定的**：Supabase 的 recovery 会话本身就是一个普通登录态，
 *     不锁住就会出现「密码没改成功、却已经能关窗走人」的白送登录态（2026-10-20 修）。
 *     只有「新密码真的设成功」或「用户点放弃重置」才解除；pending 标记落 localStorage，
 *     中途刷新页面仍会被接管（URL 里的 type=recovery 那时已被 SDK 清掉）。
 *   · 「忘记密码」先调 /api/check-email 判邮箱是否已注册：Supabase 的
 *     resetPasswordForEmail 对不存在的邮箱也返回成功（防枚举），不自己判就分不出对错。
 *     该校验是**体验增强不是前置条件**，接口不可用时一律降级为照常发信。
 *   · 改密成功后明确提示确认邮件已发往该邮箱 —— 该邮件由 Supabase 的
 *     **安全通知**模板发出（`password_changed`），见 supabase/config.toml 同名配置段。
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
  var mode = 'signin'; // signin | signup | forgot
  // 「验证邮件已发送」的待确认态所对应的邮箱；非空时 authSwitch 变成「重新发送」。
  var pendingVerifyEmail = '';
  // 「修改密码」弹层的两种模式（同一个弹层、两种校验强度）：
  //   change  —— 站内已登录：先验当前密码，再设新密码
  //   recover —— 点「重置密码」邮件里的链接回来：Supabase 已用邮件 token 换好
  //              临时会话（auth 事件 PASSWORD_RECOVERY），只需设新密码
  var pwdMode = 'change';

  /**
   * 「正在通过邮件链接重置密码」的进行中标记。
   *
   * ★ 为什么必须显式记这个：Supabase 用邮件 token 换来的 recovery 会话
   *   **本身就是一个普通登录态**。detectSessionInUrl 一落地，refresh() 就会把
   *   页面切成「已登录」，于是新密码**还没设成功**、用户就已经是登录态了 ——
   *   他关掉弹窗就能直接开始用网站，而密码一个字都没改。表现得最明显的场景
   *   就是本次修复的：用户输入与旧密码相同的值，Supabase 回「不能与原密码
   *   相同」，错误提示是对的，但只要一关弹窗人就走了，留下一个白送的登录态。
   *
   * 所以只要 recovering 为真，弹层就是**锁定的**：不给关闭按钮、点遮罩无效、
   * 失败后原地重填，只有「新密码真的改成功」或「用户主动放弃」才解除。
   */
  var recovering = false;
  /** pending 标记的键：写进 localStorage，重置途中刷新页面也能续上（URL 里的
   *  type=recovery 早被 SDK 清掉了，光看 URL 判断不回来）。 */
  var RECOVER_FLAG = 'pingze_password_recover_pending';

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
  /** 「修改密码」弹层的提示行，与 tip() 同口径但落在自己的节点上 */
  function pwdTip(msg, isError) {
    var node = $('pwdTip');
    if (!node) return;
    node.textContent = msg || '';
    node.className = isError ? 'hint err-tip' : 'hint';
  }
  /**
   * 密码强度校验（注册 / 登录 / 改密三处共用同一口径，避免三处规则漂移）。
   * @returns {string} 空串表示通过，否则是给用户看的原因
   */
  function passwordProblem(pwd) {
    if (!pwd) return '密码不能为空';
    if (pwd.length < 8) return '密码至少 8 位';
    if (!/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) return '密码要同时包含字母和数字';
    return '';
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
      setDisplay('btnPwd', false);
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
    // 「修改密码」是登录后才存在的操作：未登录一律不显示入口
    setDisplay('btnPwd', !!currentUser, 'inline-block');
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
    // 用户主动切换登录/注册时，退出「待验证」态（否则重发按钮会一直挂着）
    pendingVerifyEmail = '';
    var isSignIn = mode === 'signin';
    var isForgot = mode === 'forgot';
    if ($('authTitle')) $('authTitle').textContent = isForgot ? '重置密码' : (isSignIn ? '登录' : '注册');
    var note = $('authQuotaNote');
    if (note) {
      note.textContent = isForgot
        ? '填写注册时用的邮箱；若该邮箱没有注册过会当场提示。验证通过后我们会发一封带「重置密码」链接的邮件（有效期 1 小时，请留意垃圾邮件夹）。'
        : (isSignIn ? '登录后' : '注册后') +
          '查询记录可保存；AI 平仄分析 / 诗词鉴赏每日免费 3 次，会员 ' + DAILY_QUOTA + ' 次';
    }
    if ($('authSubmit')) $('authSubmit').textContent = isForgot ? '发送重置邮件' : (isSignIn ? '登　录' : '注　册');
    if ($('authSwitch')) $('authSwitch').textContent = isForgot ? '返回登录' : (isSignIn ? '没有账号？去注册' : '已有账号？去登录');
    // 已在「忘记密码」态就不用再显示同一个入口了
    setDisplay('authForgot', !isForgot, 'inline-block');
    // 「忘记密码」只要邮箱，密码框隐藏
    setDisplay('authPassword', !isForgot, 'block');
    var pwd = $('authPassword');
    if (isForgot && pwd) pwd.value = '';
  }

  function prettyError(error) {
    if (!error) return '操作失败，请重试';
    var msg = error.message || String(error);
    // Supabase 的错误是英文的，这里给几条常见的换成人话
    if (/Invalid login credentials/i.test(msg)) return '邮箱或密码不对';
    if (/Email not confirmed/i.test(msg)) return '邮箱还没确认，请先查收确认邮件';
    if (/User already registered/i.test(msg)) return '这个邮箱已经注册过了，直接登录吧';
    if (/Password should be at least/i.test(msg)) return '密码太短了，至少 6 位';
    if (/should be different from the old password/i.test(msg)) return '新密码不能和当前密码一样';
    if (/Unable to validate email/i.test(msg)) return '邮箱格式不对';
    // 邮件发送类错误（换 Resend SMTP 后可能遇到）
    if (/Error sending confirmation email/i.test(msg)) {
      // Supabase 只回一句笼统的 "Error sending confirmation email"，真实原因在
      // Dashboard → Authentication → Logs。绝大多数是 Resend 账号还在「测试模式」：
      // 未验证发信域名时Resend 只允许发到账号自己的邮箱，给别的地址一律 550拒收。
      // 这不是用户能自己解决的，所以明确指向运营人，避免反复重试。
      return '验证邮件暂时发不出去：邮件服务的发信域名还在验证中，' +
        '目前只能发到运营人自己的邮箱。请稍后再试，或联系运营人。';
    }
    if (/Email rate limit exceeded|over_email_send_rate_limit/i.test(msg)) {
      return '验证邮件发送太频繁，请等一分钟后再试';
    }
    if (/send.*failed|smtp|mailer/i.test(msg)) {
      return '验证邮件发送失败，请稍后重试或换个邮箱';
    }
    return msg;
  }

  /**
   * 重发验证邮件。
   *
   * 用 resend（而不是 register）是因为 Supabase 的 resend 只在「账号已存在但
   * 未验证」时才真正发信，且对**已验证**的邮箱会静默返回成功——所以这里统一
   * 返回 ok，不去猜具体结果，避免把「已验证」的用户误导去查邮件。
   *
   * 注意：不要把这里的错误原文抛给用户，可能包含内部细节。
   */
  async function resendVerify(email) {
    if (!READY || !client || !email) return { ok: false };
    try {
      var r = await client.auth.resend({ type: 'signup', email: email });
      // 「用户不存在」也算一种 ok：对用户而言就是「没有需要重发的验证」
      if (r.error && /not found|does not exist|User not found/i.test(r.error.message || '')) {
        return { ok: true };
      }
      return { ok: !r.error, reason: r.error ? prettyError(r.error) : '' };
    } catch (e) {
      return { ok: false, reason: '重发失败，请稍后再试' };
    }
  }

  /**
   * 「验证邮件已发送」的待确认态。
   *
   * 不直接关弹窗而是切成这个状态：用户此刻**还没有登录态**，如果照常关窗、
   * 显示成「注册成功」，他会直接开始用查询记录和 AI 功能，然后到处找不到哪里
   * 出问题。这里明确告知「先去查邮件、验证后回来登录」，并给一个重发入口。
   *
   * 用 pendingVerifyEmail 记录状态而不是给按钮挂 onclick：authSwitch 用的是
   * addEventListener 绑定，赋 onclick 会与之叠加导致一次点击触发两次。
   */
  function showVerifyPending(email) {
    pendingVerifyEmail = email;
    setMode('signin');
    $('authTitle').textContent = '验证邮箱';
    $('authQuotaNote').textContent =
      '验证邮件已发送到 ' + email + '，请在 24 小时内点击邮件里的链接完成验证。';
    $('authEmail').value = email;
    $('authPassword').value = '';
    tip('注册成功！先去邮箱查收验证邮件（别忘了垃圾邮件夹），验证通过后再回来登录。');
    var submit = $('authSubmit');
    if (submit) submit.textContent = '登　录';
    var sw = $('authSwitch');
    if (sw) sw.textContent = '没收到验证邮件？重新发送';
  }

  /**
   * 「忘记密码」：先确认邮箱是否已注册，再发重置邮件。
   *
   * 为什么要多这一步：Supabase 的 resetPasswordForEmail() 对**不存在的邮箱
   * 也返回成功**（刻意的防邮箱枚举设计），所以邮箱输错时用户看到的同样是
   * 「邮件已发送」，然后一直等一封永远不会来的邮件。本站要求「邮箱错就当场
   * 提示」，故先用 /api/check-email 判一次存在性。
   *
   * 降级原则（重要）：这个校验是**体验增强，不是发信的前置条件**。
   * 接口挂了 / 被限流 / 网络不通时，一律**照常发信**，绝不能因为一个辅助
   * 校验不可用就把用户挡在「找回密码」门外 —— 那比提示不友好严重得多。
   *
   * 链接回到本站后，Supabase 会用邮件里的 token 换一份**临时会话**
   * （auth 事件 PASSWORD_RECOVERY / URL 带 type=recovery），本文件据此弹出
   * 「设置新密码」。所以 redirectTo 必须落在本站，否则落地页无人接管、
   * 用户点完链接什么也看不到。
   *
   * 邮件正文与标题由 Supabase 后台的「重置密码」模板控制，不在前端。
   */
  async function sendResetEmail() {
    var email = (($('authEmail') || {}).value || '').trim();
    if (!email) return tip('请填写你的邮箱', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return tip('邮箱格式不对', true);

    var btn = $('authSubmit');
    if (btn) btn.disabled = true;
    tip('发送中…');

    // ① 判存在性。只在明确查到「没这个邮箱」时才拦下来。
    //    查不到（网络/限流/服务端故障）一律当通过，继续发信。
    var known = await checkEmailRegistered(email);
    if (known === false) {
      if (btn) btn.disabled = false;
      return tip('这个邮箱没有注册过，请核对后重新输入（要用注册时填写的那个邮箱）。', true);
    }

    try {
      var r = await client.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (r.error) return tip(prettyError(r.error), true);
      tip('重置邮件已发送到 ' + email + '，请在 1 小时内点击邮件里的链接设置新密码（别忘了垃圾邮件夹）。');
    } catch (e) {
      tip('网络异常：' + (e && e.message ? e.message : e), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * 问后端「这个邮箱注册过吗」。
   *
   * @returns {Promise<boolean|null>} true=已注册；false=明确没注册过；
   *          null=**没问出来**（接口不可用/限流/网络异常），调用方应按「放行」处理。
   */
  async function checkEmailRegistered(email) {
    try {
      var res = await fetch('/api/check-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      });
      if (!res.ok) return null;
      var data = await res.json();
      // 只认服务端明确的布尔结论；字段缺失/类型不对一律当「没问出来」
      if (!data || data.ok !== true || typeof data.exists !== 'boolean') return null;
      return data.exists;
    } catch (e) {
      return null;
    }
  }

  async function submitAuth() {
    // 「忘记密码」态只需要邮箱，密码框是隐藏的
    if (mode === 'forgot') return sendResetEmail();

    var email = ($('authEmail') || {}).value || '';
    var password = ($('authPassword') || {}).value || '';
    if (!email.trim() || !password) return tip('邮箱和密码都得填', true);
    var pwdBad = passwordProblem(password);
    if (pwdBad) return tip(pwdBad, true);

    var btn = $('authSubmit');
    if (btn) btn.disabled = true;
    tip('处理中…');
    try {
      var payload = { email: email.trim(), password: password };

      if (mode === 'signup') {
        // 走 Supabase 原生 signUp：由 Supabase 发确认邮件（SMTP 已接Resend），
        // 邮箱验证通过后才拿得到 session，登录态与 AI 配额都需先完成验证。
        //
        // 为什么不再走后端 /api/register（2026-10-16 移除）：
        //   旧实现由后端代建号、不发验证邮件，且该入口在公网上可被无限调用
        //   批量注册薅 AI 额度。现在注册回到 Supabase 自己管（发验证邮件），
        //   后端不再持有「代建号」这条路径。
        //
        // 两种返回都要处理：
        //   · 已开启 Confirm email → session 为 null，必须提示去查邮件，不能当已登录；
        //   · 未开启（Dashboard 里忘开）→ 直接返回 session，静默登录也不会出错。
        var signed = await client.auth.signUp(payload);
        if (signed.error) {
          var emsg = prettyError(signed.error);
          // 邮箱已存在但未验证过：不是「去登录」，而是要重发验证邮件
          if (/already registered|already been registered/i.test(emsg) ||
              /already exists|email_exists/i.test(emsg)) {
            var resent = await resendVerify(email.trim());
            return tip( resent.ok
              ? '这个邮箱已注册。若没收到验证邮件，我们已重新发送，请查收（含垃圾邮件）。'
              : '这个邮箱已经注册过了，直接登录吧。若一直没收到验证邮件，请确认邮箱地址无误。',
              !resent.ok);
          }
          return tip(emsg, true);
        }

        if (signed.data && signed.data.session) {
          // Dashboard 未开启邮箱确认时的兜底分支：有 session 即已是登录态
          closeModal();
          await refresh();
          return tip('注册成功，已自动登录。');
        }

        // 正常路径：账号已建好，但必须先验证邮箱
        return showVerifyPending(email.trim());
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
    // 任何一条登出路径都要清掉「重置进行中」标记：只要用户登出了，
    // 「必须先设完新密码」的锁定就没有意义了，留着下次打开会误弹。
    setRecovering(false);
    closePwdModal();
    await refresh();
  }

  // ---------------------------------------------------------------- 修改密码

  /**
   * 打开「修改密码」弹层。
   * @param {'change'|'recover'} [nextMode]
   *   change  —— 站内已登录改密：必须提供当前密码（防「捡到会话就能改密码」）
   *   recover —— 重置邮件链接落地：Supabase 已建好临时会话，免验旧密码，
   *              且**锁定弹层**，必须设完新密码（或主动放弃）才能离开
   */
  function openPwdModal(nextMode) {
    var m = nextMode === 'recover' ? 'recover' : 'change';
    // 站内改密的前提是登录态；未登录时不该出现这个入口
    if (m === 'change' && !currentUser) {
      openLogin('请先登录后再修改密码。');
      return;
    }
    pwdMode = m;
    var isRecover = m === 'recover';
    if (isRecover) setRecovering(true);
    if ($('pwdTitle')) $('pwdTitle').textContent = isRecover ? '设置新密码' : '修改密码';
    if ($('pwdNote')) {
      $('pwdNote').textContent = isRecover
        ? '你通过邮件里的重置链接进入了改密流程，新密码要输入两遍。' +
          '设置成功之前无法关闭本窗口 —— 否则密码没改、却留下一个已登录状态。'
        : '先验证原密码，再设置新密码（新密码要输入两遍）。';
    }
    // ★ 每次打开都要把**所有**输入框的显隐复位，不能只管 pwdCurrent。
    //   改密成功后为了做「完成」态，这里曾把三个框全设成 display:none；
    //   而 pwdNew / pwdNew2 从没被复位，于是「成功过一次之后再打开弹层」
    //   只剩一个孤零零的原密码框（2026-10-20 线上截图反馈的实际 bug）。
    //   可见性是 openPwdModal 的责任，成功态去隐藏它、失败/成功都不该留下残留。
    setDisplay('pwdCurrent', !isRecover, 'block');
    setDisplay('pwdNew', true, 'block');
    setDisplay('pwdNew2', true, 'block');
    setDisplay('pwdSubmit', true);
    setDisplay('pwdTip', true);
    ['pwdCurrent', 'pwdNew', 'pwdNew2'].forEach(function (id) {
      var n = $(id);
      if (n) n.value = '';
    });
    var sub = $('pwdSubmit');
    if (sub) { sub.disabled = false; sub.textContent = isRecover ? '设 置 新 密 码' : '保 存 新 密 码'; }
    var cls = $('pwdClose');
    // 重置流程进行中：唯一的出口是「放弃重置」，不是「关闭」
    if (cls) cls.textContent = isRecover ? '放弃重置，用原密码登录' : '关闭';
    pwdTip('');
    setDisplay('pwdModal', true, 'flex');
    var focus = isRecover ? $('pwdNew') : $('pwdCurrent');
    if (focus && focus.focus) focus.focus();
  }
  function closePwdModal() {
    setDisplay('pwdModal', false);
  }

  /** 置位/清除「重置进行中」标记，同时落一份到 localStorage 供刷新后续上 */
  function setRecovering(on) {
    recovering = !!on;
    try {
      if (recovering) window.localStorage.setItem(RECOVER_FLAG, '1');
      else window.localStorage.removeItem(RECOVER_FLAG);
    } catch (e) {
      /* 隐私模式 / 禁用存储时不可用；此时仅靠内存标记，功能仍可用 */
    }
  }
  function readRecoverFlag() {
    try {
      return window.localStorage.getItem(RECOVER_FLAG) === '1';
    } catch (e) {
      return false;
    }
  }

  /**
   * 用户主动放弃重置。
   *
   * 出口是必需的：recovery 会话有有效期，万一过期后弹层关不掉，用户就被困住了。
   * 放弃 = 清标记 + 退出这个 recovery 会话 + 回到登录框（原来的密码仍然有效）。
   */
  function abandonRecovery() {
    setRecovering(false);
    closePwdModal();
    var done = signOut();
    if (done && typeof done.then === 'function') {
      done.then(function () { openLogin('已放弃本次密码重置，你的原密码仍然有效。'); });
    }
  }

  /**
   * 提交改密。
   *
   * change 模式下**先验旧密码再改**：Supabase 的 updateUser() 只认会话，
   * 不校验旧密码——不验就等于「谁拿到会话谁就能改密码」。验的方式是拿
   * 邮箱 + 当前密码重新 signInWithPassword 一次，失败即中止。
   */
  async function submitPwd() {
    if (!client) return pwdTip('账号功能未启用，暂不能修改密码', true);
    var isRecover = pwdMode === 'recover';
    var cur = ($('pwdCurrent') || {}).value || '';
    var nw = ($('pwdNew') || {}).value || '';
    var nw2 = ($('pwdNew2') || {}).value || '';

    var bad = passwordProblem(nw);
    if (bad) return pwdTip(bad, true);
    if (nw !== nw2) return pwdTip('两次输入的新密码不一致', true);

    var btn = $('pwdSubmit');
    if (btn) btn.disabled = true;
    var done = false;
    try {
      if (isRecover) {
        // 重置链接换来的临时会话可能已被用过 / 过期，此时 currentUser 为空。
        // 这条路已经走不通了，清掉 pending 标记，避免下次打开页面还弹出改密框。
        if (!currentUser) {
          setRecovering(false);
          return pwdTip('这个重置链接已失效或已被使用。请点「放弃重置」回到登录框，' +
            '再用「忘记密码」重新发送一封邮件。', true);
        }
      } else {
        if (!currentUser) return pwdTip('登录状态已失效，请重新登录后再改密码', true);
        if (!cur) return pwdTip('请先填写当前密码', true);
        if (cur === nw) return pwdTip('新密码不能和当前密码一样', true);
        pwdTip('正在验证当前密码…');
        var chk = await client.auth.signInWithPassword({
          email: currentUser.email,
          password: cur,
        });
        if (chk.error) {
          if (/invalid login credentials/i.test(chk.error.message || '')) {
            return pwdTip('当前密码不对，请重新输入', true);
          }
          return pwdTip(prettyError(chk.error), true);
        }
      }

      var upd = await client.auth.updateUser({ password: nw });
      // ★ 失败（含「不能与原密码相同」）时这里直接 return：
      //   弹层保持打开、recovering 保持为真 ⇒ 用户仍被锁在重置流程里，
      //   不能关窗走人，也不会看到一个「密码没改但已登录」的界面。
      if (upd.error) return pwdTip(prettyError(upd.error), true);

      // 成功：解除锁定 + 弹层切成「完成」态而不是直接关掉，
      // 否则用户不知道到底改没改成。
      // 去隐藏输入框只为这一屏的观感，下次 openPwdModal() 会全部复位。
      done = true;
      setRecovering(false);
      var mailTo = (currentUser && currentUser.email) || '';
      if ($('pwdTitle')) $('pwdTitle').textContent = '密码已修改';
      if ($('pwdNote')) $('pwdNote').textContent = '请牢记新密码，下次登录请使用新密码。';
      setDisplay('pwdCurrent', false);
      setDisplay('pwdNew', false);
      setDisplay('pwdNew2', false);
      setDisplay('pwdSubmit', false);
      var cls = $('pwdClose');
      if (cls) cls.textContent = '完成';
      // 必须明确告知确认邮件已发：这是一封**安全通知**，用户没收到就等于
      // 「有没有人偷改我密码」的预警失效了，别静默成功让用户无从察觉。
      // 前提：Supabase 侧必须已开启 `mailer_notifications_password_changed_enabled`
      //（安全通知默认关闭，不开就收不到；见 supabase/config.toml 同名配置段注释）。
      pwdTip('修改成功。密码变更确认通知已发往 ' + mailTo +
        '，请留意收件箱（含垃圾邮件）；若非本人操作，请立即用「忘记密码」重置密码。');
      await refresh();
    } catch (e) {
      pwdTip('网络异常：' + (e && e.message ? e.message : e), true);
    } finally {
      if (btn && !done) btn.disabled = false;
    }
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
   * 保存流程的收尾动作：确保「查询记录」面板打开且内容是最新的。
   * 原本关着 -> 打开并滚过去；原本开着 -> 只刷新内容
   * （用户就在面板附近，再滚一次反而打断他）。
   *
   * 独立成函数的原因：这条链路有两个入口都会用到 ——
   * 新插入成功、以及「本次查询早就存过了」（此时不该重复插，
   * 但用户点了保存，意图就是「看到记录」，面板必须照常打开刷新）。
   */
  async function openAndRefreshRecords() {
    var wasOpen = recordsOpen();
    showRecords(true);
    await loadRecords();
    if (!wasOpen) scrollToRecords();
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

    // 防重复入库：已为「本次查询结果」保存过就不再重复插。
    // ★ 但仍要走打开 + 刷新：AI 赏析入库时 ensureQuerySaved() 会静默补一条
    //   queries 记录并置上这里的标记，用户随后点「保存本次查询」正会命中本分支，
    //   若在这里直接 return，面板就永远打不开（2026-10-16 回归的原因）。
    if (currentQueryId && savedForInput === lastInput) {
      if (node) { node.textContent = '本次查询已保存到「查询记录」'; node.className = 'ok'; }
      await openAndRefreshRecords();
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
      // 保存成功后自动打开「查询记录」面板并刷新内容
      await openAndRefreshRecords();
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
        // replay:true —— 回放的是已存记录，AI 赏析内容随记录一起回显，
        // 开关会置灰锁定，防止对同一条诗重复生成（重复扣额度、结果也几乎一样）
        if (window.renderResult) window.renderResult(row.result, { replay: true });
        // 告诉账号系统「当前就是这条记录」：后续 AI 生成会挂回这一条，
        // 不会在库里重复插一条同名查询
        if (window.PingzeAuth) {
          window.PingzeAuth.onQueryDone(row.input_text || '', row.result, row.id);
        }
        // AI 内容回放：只填文本，不代用户勾开关（回放态开关已锁定，用户无法自行打开）
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
    /** 打开「修改密码」弹层（外部若需触发可用；未登录时会先弹登录框） */
    openPwdModal: openPwdModal,
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
    if ($('btnPwd')) $('btnPwd').addEventListener('click', function () {
      openPwdModal('change');
    });
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
      // 「验证待确认」态下这个按钮是「没收到？重新发送」，不是切换登录/注册。
      if (pendingVerifyEmail) {
        var target = pendingVerifyEmail;
        resendVerify(target).then(function (r) {
          tip(r.ok ? '已重新发送，请查收邮件（含垃圾邮件夹）。' : (r.reason || '重发失败，请稍后再试'), !r.ok);
        });
        return;
      }
      setMode(mode === 'signin' ? 'signup' : 'signin');
    });
    if ($('authForgot')) $('authForgot').addEventListener('click', function () {
      setMode('forgot');
      tip('');
    });
    if ($('authClose')) $('authClose').addEventListener('click', closeModal);
    if ($('pwdSubmit')) $('pwdSubmit').addEventListener('click', submitPwd);
    if ($('pwdClose')) {
      $('pwdClose').addEventListener('click', function () {
        // 重置流程进行中：这不是「关闭」，是「放弃重置」（退出会话、回到登录框）
        if (pwdMode === 'recover' && recovering) { abandonRecovery(); return; }
        closePwdModal();
      });
    }
    if ($('qrClose')) $('qrClose').addEventListener('click', closeQr);
    if ($('pwdModal')) {
      $('pwdModal').addEventListener('click', function (e) {
        if (e.target !== $('pwdModal')) return;
        // 锁定期间点遮罩**不能**关窗：密码还没改成功就放人走 = 白送一个登录态
        if (pwdMode === 'recover' && recovering) return;
        closePwdModal();
      });
    }
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
    var mail = $('authEmail');
    if (mail) mail.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitAuth();
    });
    // 改密弹层里三个输入框都支持回车提交（当前密码框尤其需要）
    ['pwdCurrent', 'pwdNew', 'pwdNew2'].forEach(function (id) {
      var n = $(id);
      if (!n) return;
      n.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submitPwd();
      });
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
      resumeRecoveryIfPending();
    });
  } else {
    wire();
    refresh();
    resumeRecoveryIfPending();
  }

  /**
   * 重置途中刷新页面后的接管。
   *
   * 邮件链接被 SDK 处理完就把 URL 清干净了，`type=recovery` 已经读不到，
   * 但「密码还没设成功」这件事记在 localStorage 里 —— 否则用户刷新一下就
   * 变成一个普通已登录页面，密码没改却畅通无阻（和本次修的 bug 同一个洞）。
   */
  function resumeRecoveryIfPending() {
    if (!client || !readRecoverFlag()) return;
    client.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s && s.user) {
        refresh().then(function () { openPwdModal('recover'); });
      } else {
        // 会话没了（过期 / 被登出）→ 标记是脏的，清掉别再弹
        setRecovering(false);
      }
    }).catch(function () { setRecovering(false); });
  }

  if (client) {
    client.auth.onAuthStateChange(function (event, session) {
      // 「重置密码」邮件链接的落地：Supabase 已用邮件里的 token 换好一份临时会话，
      // 事件类型是 PASSWORD_RECOVERY（URL 同时带 type=recovery）。
      // 此刻用户**还没有设新密码**，若照常刷成「已登录」界面，他会在毫不知情的
      // 情况下变成已登录状态且密码没改掉——所以必须直接弹出「设置新密码」，
      // 并把弹层锁住直到新密码真的设成功（见 recovering）。
      if (event === 'PASSWORD_RECOVERY') {
        refresh().then(function () { openPwdModal('recover'); });
        return;
      }
      // 锁定期间会话被作废（重置链接过期 / 被登出）：锁定已无意义，
      // 主动解除并说明原因，否则用户会被困在一个点不掉的弹层里。
      if (event === 'SIGNED_OUT' && recovering) {
        setRecovering(false);
        closePwdModal();
        openLogin('登录状态已失效（重置链接可能已过期），请重新登录，或用「忘记密码」再发一封重置邮件。');
        return;
      }
      refresh();
    });

    // -------- 验证 / 重置邮件链接的落地处理 --------
    // 用户点邮件里的链接后会带着 #access_token=...（成功）或
    // #error=access_denied&error_code=otp_expired&...（失效）回到本站。
    // 上面 onAuthStateChange 只管「有 session」，错误分支它完全不触发，
    // 于是用户只看到地址栏里的乱码参数、页面毫无反应——必须显式识别。
    (function handleVerifyCallback() {
      var hash = String(window.location.hash || '');
      if (hash.indexOf('#') !== 0) hash = '';
      var params = {};
      if (hash) {
        hash.slice(1).split('&').forEach(function (kv) {
          var p = kv.split('=');
          if (p[0]) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
        });
      }
      // type 同时可能出现在 hash 与 query 里，两边都要看
      ['error', 'error_code', 'error_description', 'type', 'access_token'].forEach(function (k) {
        var q = new URLSearchParams(window.location.search).get(k);
        if (q && !params[k]) params[k] = q;
      });

      // 「重置密码」链接与「邮箱验证」链接的错误提示完全不同，别混着说
      var isRecovery = /recovery/i.test(params.type || '');

      if (params.error || params.error_code) {
        var msg;
        var expired = /otp_expired|expired|invalid/i.test(params.error_code + ' ' + params.error_description);
        if (isRecovery && expired) {
          msg = '这个重置密码链接已失效或已被使用（有效期 1 小时，且只能用一次）。' +
            '请回到登录框点「忘记密码」重新发送一封邮件。';
        } else if (expired) {
          msg = '这个验证链接已失效或已被使用。请回到登录框重新登录，' +
            '登录时若提示邮箱未验证，点「没收到验证邮件？重新发送」即可。';
        } else if (isRecovery) {
          msg = '重置密码没有完成（' + (params.error_description || params.error_code || params.error) +
            '）。请回到登录框点「忘记密码」重新发送邮件。';
        } else {
          msg = '邮箱验证没有完成（' + (params.error_description || params.error_code || params.error) +
            '）。请重新登录并重发验证邮件。';
        }
        openLogin(msg);
        // 清掉地址栏里的 token/错误参数，避免刷新时重复报错
        try {
          history.replaceState(null, '', window.location.pathname + window.location.search);
        } catch (e) {}
        return;
      }

      // 带 access_token 回来 = 验证成功。SDK 已在 detectSessionInUrl 下自动
      // 建立会话，页面会变成已登录界面——这里**不要**再弹任何提示：
      // 用户点链接回来的预期就是「直接进去用」，弹个登录框反而像出错。
      // （唯一例外是 type=recovery：那不是验证，是改密入口，见下。）
      //
      // 兜底 refresh：SDK 处理 URL 里的 token 是异步的，而本文件的
      // refresh() 在 onAuthStateChange 注册**之前**就调用过一次。极端时序下
      // 那次读到的还是空会话。这里再主动读一次，确保一定切成登录态。
      if (params.access_token) {
        // 先让 SDK 把 URL 里的 token 收进 session（不要抢在它前面清 URL），
        // 再刷界面。等会话确实落到 storage 后才清地址栏。
        var waitForSession = function (tries) {
          refresh().then(function () {
            if (currentUser || tries <= 0) {
              // 会话已就绪（或已尽力），清掉地址栏里的 token
              try {
                history.replaceState(null, '', window.location.pathname);
              } catch (e) {}
              // 改密链接：直接弹「设置新密码」（免验旧密码）。
              // 与 PASSWORD_RECOVERY 事件互为兜底——谁先到都行，
              // 弹层是幂等的，重复打开只是重置输入框。
              if (isRecovery && currentUser) openPwdModal('recover');
              return;
            }
            setTimeout(function () { waitForSession(tries - 1); }, 150);
          });
        };
        waitForSession(6);   // 最多等约 1s
      }
    })();
  }
})();
