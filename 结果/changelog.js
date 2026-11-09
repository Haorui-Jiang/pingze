/**
 * 结果/changelog.js —— 网站「更新日志」弹窗
 *
 * 交互约定：
 *   · 页脚「更新日志」入口随时可打开；弹窗按倒序列出全部历史条目（日期 + 内容）。
 *   · 每次发布**实质性**更新：只需在 CHANGELOG 数组**最前面**加一条（version 取新值、
 *     date 填发布日期），LATEST_VERSION 自动取首条。用户下次打开网站时，
 *     localStorage 里的已读版本与本版本不一致 → 自动弹出本次更新，且只弹一次。
 *   · ★ 收录范围（用户 2026-11-09 定）：只记功能 / 规则 / 额度 / 价格等用户需要知道的
 *     实质变更；**纯界面风格类调整（样式、下划线、按钮增删、链接标注等）不记入
 *     CHANGELOG，也不要为此更换 version**——否则每次视觉微调都会弹窗打扰全部访客。
 *   · 已读状态存 localStorage（同源共享）：首页与 /pingshui-yun 用同一把 key，
 *     在任一页看过，另一页不再打扰；打开弹窗即标记已读（含自动弹出）。
 *   · 密码重置邮件落地（type=recovery）时不自动弹，避免压住改密弹层；
 *     此时入口保留未读红点，用户可自行点开。
 *
 * 兼容 Node：纯函数（shouldAutoOpen / renderList / readSeen / markSeen / esc）
 * 由 tools/verify-changelog.js 直接 require 单测；init() 需要 DOM，由页面显式调用，
 * require 本模块不会碰 document。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PingzeChangelog = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  var STORAGE_KEY = 'pingze.changelog.seen';

  /**
   * ★ 新增更新日志就往数组最前面加一条：
   *   version  唯一标识，建议 YYYYMMDD（同日多次发布加 -2）。**必须是新值**，
   *            与用户本地已读值相同就不会自动弹出；
   *   date     面向用户展示的发布日期（YYYY-MM-DD）；
   *   title    本次更新标题；items 要点列表（纯文本，渲染时统一 HTML 转义）。
   *
   * ★ 只收实质变更（功能、规则、额度、价格）。界面风格类调整不进 CHANGELOG，
   *   也别换 version —— 加了条目就等于强制所有访客下次打开必看一次弹窗。
   */
  var CHANGELOG = [
    {
      version: '20261109',
      date: '2026-11-09',
      title: 'AI 赏析额度与会员体系调整',
      items: [
        '免费用户：每日 AI 赏析额度由 3 次提升至 10 次',
        '会员：每日额度由 10 次提升至 50 次，价格调整为 ¥20 / 月',
        '新增「特级会员」：每日 AI 赏析不限次数，¥50 / 月',
        '管理后台支持免费 / 会员 / 特级三档切换，网站新增「更新日志」入口'
      ]
    }
  ];

  var LATEST_VERSION = CHANGELOG[0].version;

  /**
   * 撤回过的临时版本 → 现行版本的折算表。
   * 2026-11-09 曾短暂发布 '20261109-2'（界面细节条目），按收录规则已删除；
   * 已把这版记为已读的用户本地仍是旧值，若直接把版本回退到 '20261109'，
   * 他们会再被弹一次上一条配额日志。以后再有「发了又撤回」的版本，加一行即可。
   */
  var SEEN_ALIASES = { '20261109-2': '20261109' };

  function normalizeSeen(seen) {
    return seen && SEEN_ALIASES[seen] ? SEEN_ALIASES[seen] : seen;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  /** 版本不一致就该自动弹；首次访问（seen=null）也算新版本 */
  function shouldAutoOpen(seen, latest) {
    return normalizeSeen(seen) !== (latest || LATEST_VERSION);
  }

  /** 隐私模式 / 禁用存储时 getItem 会抛，按「没读过」处理，不能让页面崩 */
  function readSeen(storage) {
    try { return storage ? storage.getItem(STORAGE_KEY) : null; }
    catch (e) { return null; }
  }

  function markSeen(storage, version) {
    try {
      if (!storage) return false;
      storage.setItem(STORAGE_KEY, version || LATEST_VERSION);
      return true;
    } catch (e) { return false; }
  }

  function safeStorage() {
    try { return root && root.localStorage ? root.localStorage : null; }
    catch (e) { return null; }
  }

  /** 纯函数：日志数组 → 弹窗列表 HTML（最新版本那条标「最新」） */
  function renderList(entries, latest) {
    var list = Array.isArray(entries) ? entries : CHANGELOG;
    var cur = latest || LATEST_VERSION;
    var found = list.some(function (e) { return e.version === cur; });
    if (!found && list.length) cur = list[0].version;   // 注入的未来版本也要有高亮
    return list.map(function (e) {
      var items = (e.items || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
      return '<li class="cl-item' + (e.version === cur ? ' is-latest' : '') + '">' +
        '<div class="cl-head">' +
          '<time class="cl-date" datetime="' + esc(e.date) + '">' + esc(e.date) + '</time>' +
          (e.version === cur ? '<span class="cl-tag">最新</span>' : '') +
        '</div>' +
        '<div class="cl-title">' + esc(e.title) + '</div>' +
        '<ul class="cl-items">' + items + '</ul>' +
      '</li>';
    }).join('');
  }

  /** 密码重置落地页：auth.js 会弹改密框，别用更新日志压住它 */
  function isRecoveryLanding(loc) {
    var u = loc || (root && root.location) || {};
    var s = String(u.hash || '') + String(u.search || '');
    return /type=recovery/.test(s);
  }

  /**
   * 初始化（每个页面显式调用一次）。
   * opts 仅供测试注入：{ doc, storage, loc, latestVersion, autoOpen }
   */
  function init(opts) {
    opts = opts || {};
    var doc = opts.doc || (root && root.document);
    if (!doc) return null;
    var storage = opts.storage !== undefined ? opts.storage : safeStorage();
    var latest = opts.latestVersion || LATEST_VERSION;

    var mask = doc.getElementById('clModal');
    var list = doc.getElementById('clList');
    var sub = doc.getElementById('clSub');
    var closeBtn = doc.getElementById('clClose');
    var entry = doc.getElementById('changelogLink');
    if (!mask || !list || !closeBtn) return null;

    list.innerHTML = renderList(CHANGELOG, latest);
    if (sub) sub.textContent = '最近更新：' + CHANGELOG[0].date + ' · 共 ' + CHANGELOG.length + ' 条记录';

    function isOpen() { return mask.classList.contains('is-open'); }

    function syncBadge() {
      if (!entry || !entry.classList) return;
      if (shouldAutoOpen(readSeen(storage), latest)) entry.classList.add('has-new');
      else entry.classList.remove('has-new');
    }

    function open() {
      mask.classList.add('is-open');
      // 打开即已读：用户直接关掉标签页也不会在下次打开时重复打扰
      markSeen(storage, latest);
      syncBadge();
    }
    function close() { mask.classList.remove('is-open'); }

    // 幂等：重复 init（热更新 / 测试）不重复绑事件，只重算状态
    if (!mask._clWired) {
      if (entry && entry.addEventListener) {
        entry.addEventListener('click', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          open();
        });
      }
      if (closeBtn.addEventListener) closeBtn.addEventListener('click', close);
      if (mask.addEventListener) {
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
      }
      if (doc.addEventListener) {
        doc.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && isOpen()) close();
        });
      }
      mask._clWired = true;
    }

    var auto = opts.autoOpen !== false && shouldAutoOpen(readSeen(storage), latest) &&
      !isRecoveryLanding(opts.loc);
    if (auto) open(); else syncBadge();

    return { open: open, close: close, isOpen: isOpen, syncBadge: syncBadge };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    CHANGELOG: CHANGELOG,
    LATEST_VERSION: LATEST_VERSION,
    SEEN_ALIASES: SEEN_ALIASES,
    normalizeSeen: normalizeSeen,
    esc: esc,
    shouldAutoOpen: shouldAutoOpen,
    readSeen: readSeen,
    markSeen: markSeen,
    renderList: renderList,
    isRecoveryLanding: isRecoveryLanding,
    init: init,
  };
});
