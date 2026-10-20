// Netlify Function：判定邮箱是否已注册（「忘记密码」链路用）
// 挂载路径：/.netlify/functions/check-email（经 netlify.toml 的 /api/* 映射成 /api/check-email）
// 判定逻辑在 lib/account-lookup.js，与本地 server.local.js 共用同一份实现。

const lookup = require('../../lib/account-lookup');
const limiter = require('../../lib/rate-limit');

// CORS 只允许本站来源（与 admin-set-tier 一致）。
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pingze.site';

// ★ 这个接口「返回邮箱是否存在」= 一个邮箱枚举入口，是有意为之的取舍
//   （Supabase 的 resetPasswordForEmail 对不存在邮箱也返回成功，拿不到存在性信号）。
//   所以限流必须比 AI 接口更紧：AI 是花钱，这个是泄露用户名单。
//   10 次 / 10 分钟 / IP —— 正常人手抖输错十来次也够用，脚本批量枚举会很难受。
const RATE_LIMIT = parseInt(process.env.CHECK_EMAIL_RATE_LIMIT || '10', 10) || 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;

exports.handler = async function (event) {
  const reqOrigin = (event.headers || {}).origin || (event.headers || {}).Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (reqOrigin === ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = reqOrigin;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST 方法' }) };
  }

  // 限流放在解析请求体之前：被限流的请求不做任何昂贵工作。
  const rl = limiter.hit(limiter.ipFromEvent(event), {
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    prefix: 'chkemail',
    message: '校验次数过多，请约 10 分钟后再试。平仄查询不受影响。',
  });
  if (!rl.ok) {
    headers['Retry-After'] = String(rl.retryAfterSec);
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ ok: false, reason: 'rate_limited', error: rl.message, retryAfterSec: rl.retryAfterSec }),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }) };
  }

  const out = await lookup.emailExists(parsed.email);

  // 查不出来（配置缺失 / 查询失败）时**不能**告诉前端「邮箱不存在」——
  // 那会让真实用户一直输不对。前端收到 ok:false 会直接降级为「照常发信」。
  if (!out.ok) {
    console.error('[check-email] 查询失败:', out.reason);
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ ok: false, reason: out.reason, error: '邮箱校验暂时不可用，请稍后重试。' }),
    };
  }

  // 只回布尔值，不回 user id / 任何档案信息
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, exists: out.exists }),
  };
};
