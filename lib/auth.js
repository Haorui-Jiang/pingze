'use strict';

/**
 * 注册逻辑（被 server.local.js 与 netlify/functions/register.js 共用）
 *
 * 为什么绕开 Supabase 自带的 signUp：
 *   项目开着邮箱确认（mailer_autoconfirm=false），每次注册都会发一封确认邮件，
 *   而默认 SMTP 限 2 封/小时、且只发给团队成员白名单地址 —— 用户注册直接 429，
 *   连账号都建不起来。
 *
 *   改用 service_role 调管理接口建号并直接标记 email_confirm=true：
 *   全程不发邮件，不受邮件限流，也不要求用户去 Dashboard 关掉确认开关。
 *
 * 代价（必须知道）：
 *   邮箱真实性不再校验，任何人都能拿不存在的邮箱注册。所以这里自带三道闸：
 *   密码强度、单 IP 限流、全站每小时上限。等接了自定义 SMTP，应恢复邮箱校验。
 */

const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ENABLED = Boolean(SUPABASE_URL && SERVICE_KEY);

// 单 IP 每小时最多注册几个（进程内计数，Serverless 上是尽力而为）
const MAX_PER_IP_PER_HOUR = Number(process.env.REGISTER_MAX_PER_IP || 3);
// 全站每小时最多新增多少账号（走数据库计数，跨实例有效，是真正的兜底闸）
const MAX_PER_HOUR = Number(process.env.REGISTER_MAX_PER_HOUR || 50);
const WINDOW_MS = 60 * 60 * 1000;

const ipHits = new Map(); // ip -> [timestamp, ...]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 邮箱规范化：去空白、转小写。避免同一个邮箱注册出两个账号 */
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function validate(email, password) {
  if (!email || !password) return '邮箱和密码都得填';
  if (!EMAIL_RE.test(email) || email.length > 254) return '邮箱格式不对';
  if (password.length < 8) return '密码至少 8 位';
  // Supabase 默认只要求 6 位，这里收紧一点：必须同时含字母和数字
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码要同时包含字母和数字';
  if (password.length > 72) return '密码太长了（最多 72 位）';
  return null;
}

function prune(arr, now) {
  return arr.filter((t) => now - t < WINDOW_MS);
}

function ipLimited(ip) {
  const now = Date.now();
  const list = prune(ipHits.get(ip) || [], now);
  if (list.length >= MAX_PER_IP_PER_HOUR) {
    ipHits.set(ip, list);
    return true;
  }
  list.push(now);
  ipHits.set(ip, list);
  return false;
}

/**
 * 全站每小时新增账号数。
 * profiles 由 handle_new_user 触发器在 auth.users 插入时同步创建，
 * 所以数它等价于数新注册，且比拉 auth.users 列表便宜得多。
 */
async function signupsLastHour() {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const url = SUPABASE_URL + '/rest/v1/profiles?select=id&limit=0&created_at=gte.' +
    encodeURIComponent(since);
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, Prefer: 'count=exact' },
  });
  if (!res.ok) {
    // 数不出来就别拦，宁可放宽也不能把正常注册挡在门外
    console.warn('[auth] 全站注册计数失败，放行本次请求:', res.status);
    return -1;
  }
  const range = res.headers.get('content-range') || '';
  const total = range.split('/')[1];
  return total && total !== '*' ? Number(total) : 0;
}

/** Supabase 管理接口的错误码换成人话 */
function mapAdminError(status, body) {
  const msg = (body && (body.msg || body.message)) || '';
  const code = (body && (body.code || body.error_code)) || '';
  if (/already been registered|already exists|email_exists/i.test(msg + code) ||
      code === 'email_exists') {
    return '这个邮箱已经注册过了，直接登录吧';
  }
  if (/password/i.test(msg)) return '密码不符合要求：' + msg;
  if (status === 429) return '操作太频繁，请稍后再试';
  return '注册失败，请稍后重试';
}

function apiError(status, message) {
  return { status: status, body: { error: message } };
}

/**
 * 注册。返回 { status, body }，调用方直接回给客户端。
 * ip 由调用方从请求里取（Serverless 走 x-forwarded-for）。
 */
async function register(rawEmail, password, ip) {
  if (!ENABLED) {
    return apiError(500, '服务端未配置 SUPABASE_URL / SUPABASE_SERVICE_KEY，注册功能不可用');
  }
  const email = normalizeEmail(rawEmail);
  const bad = validate(email, password);
  if (bad) return apiError(400, bad);

  if (ip && ipLimited(ip)) {
    return apiError(429, '注册太频繁了，请一小时后再试');
  }

  try {
    const used = await signupsLastHour();
    if (used >= 0 && used >= MAX_PER_HOUR) {
      return apiError(429, '本站注册人数已达上限，请稍后再试');
    }
  } catch (e) {
    console.warn('[auth] 限流检查异常，放行:', e && e.message);
  }

  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: email, password: password, email_confirm: true }),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    return apiError(res.status, mapAdminError(res.status, data));
  }

  // 不把 user 对象的敏感字段往外抛
  return {
    status: 200,
    body: {
      ok: true,
      email: email,
      userId: data && data.id ? data.id : null,
      confirmed: true,
    },
  };
}

module.exports = {
  ENABLED: ENABLED,
  register: register,
  normalizeEmail: normalizeEmail,
  validate: validate,
  _hash: (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16),
};
