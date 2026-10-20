'use strict';

/**
 * lib/account-lookup.js —— 判定「某邮箱是否已注册」（被两个后端共用）
 *   · server.local.js                     （本地常驻进程）
 *   · netlify/functions/check-email.js    （Serverless 函数）
 *
 * 为什么需要它：
 *   Supabase 的 resetPasswordForEmail() 对**不存在的邮箱也返回成功**，
 *   这是刻意的防邮箱枚举设计（否则攻击者可用它批量探测哪些邮箱注册过）。
 *   所以「密码重置」这条链路拿不到任何存在性信号，用户输错邮箱时看到的
 *   也是「邮件已发送」，然后一直等一封永远不会来的邮件。
 *   本站的产品要求是「邮箱错就当场提示」，只能自己查一次。
 *
 * ★ 这个接口因此**本身就是邮箱枚举入口**，属于有意为之的取舍：
 *   · 必须在调用方（check-email.js）做 IP 限流；
 *   · 只返回布尔值，不返回 user id / 创建时间等任何额外信息；
 *   · 日后若不想暴露，把 check-email.js 的调用方关掉即可，
 *     前端会自动降级为「直接发信」（见 结果/auth.js 的 sendResetEmail）。
 *
 * 数据来源说明（为什么查 profiles 而不是 auth.users）：
 *   · auth.users 在 `auth` schema，**不在 PostgREST 暴露的 schema 里**，
 *     service key 也 SELECT 不到，只能靠 security definer RPC 或 Admin API；
 *   · public.profiles 由迁移 0005 的 handle_new_user() 触发器创建，
 *     `id uuid references auth.users(id) on delete cascade` ⇒ 每个 auth 用户
 *     必有一行；`email` 由同一触发器从 auth.users 镜像。
 *   · 迁移 0005 加 email 列时**没有回填**存量数据，但 2026-10-20 线上实测
 *     3 条 profiles 全部有 email（存量用户都是 0005 之后注册的）。
 *     触发器在 email 缺失时也会兜底建行，故真实邮箱账号不会漏。
 *   · 万一哪天出现 email 为 NULL 的历史脏数据，这里只会把它判成
 *     「邮箱不存在」→ 用户重置邮件仍会发出（见前端降级说明），
 *     最坏结果是多一句「没注册过」的提示，而不是账号被锁死。
 */

const store = require('./supabase-store');

/** 邮箱格式校验：与前端 结果/auth.js 的 sendResetEmail 同一口径（尽量宽松，别误杀） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RFC 上限 254 字符，防止拿超长串去打 REST 查询 */
const EMAIL_MAX = 254;

/** 归一化：去空白 + 转小写。邮箱本地部分理论可大小写敏感，但本站全是 gmail/qq/163，实际无歧义 */
function normalizeEmail(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s || s.length > EMAIL_MAX) return '';
  return EMAIL_RE.test(s) ? s.toLowerCase() : '';
}

/**
 * 判定邮箱是否已注册。
 *
 * ★ 返回值里 `ok:false` 表示**没查出来**（配置缺失 / 格式非法 / 查询失败），
 *   绝不等于「邮箱不存在」。调用方必须把这两件事分开回给前端 ——
 *   把服务端故障说成「邮箱输入错误」，会让真实用户反复输都输不对。
 *
 * @param {string} raw 用户输入的邮箱
 * @returns {Promise<{ok:boolean, exists?:boolean, reason?:string}>}
 *          ok=true  → { exists: true|false }（查到了，可信）
 *          ok=false → { reason: 'no-config' | 'bad-email' | 'lookup-failed' }
 */
async function emailExists(raw) {
  if (!store.ENABLED) return { ok: false, reason: 'no-config' };
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, reason: 'bad-email' };

  try {
    // profiles.email 上有唯一索引（迁移 0005），等值查询走索引，代价 O(1) 量级。
    // 只取 id 且 limit=1：不需要把任何用户信息带回服务端。
    const rows = await store.restFetch(
      '/profiles?select=id&email=eq.' + encodeURIComponent(email) + '&limit=1',
      { method: 'GET' }
    );
    return { ok: true, exists: Array.isArray(rows) && rows.length > 0 };
  } catch (e) {
    return { ok: false, reason: 'lookup-failed' };
  }
}

module.exports = {
  EMAIL_RE: EMAIL_RE,
  EMAIL_MAX: EMAIL_MAX,
  normalizeEmail: normalizeEmail,
  emailExists: emailExists,
};
