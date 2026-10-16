// Netlify Function 版 AI 赏析接口（V5）
// 挂载路径：/.netlify/functions/ai-insight（经 netlify.toml 重定向 /api/* 映射，
//           对外即 POST /api/ai-insight）
// API Key 由 Netlify 站点环境变量注入（DEEPSEEK_API_KEY），前端不传密钥。
//
// 与本地 server.local.js 共用同一份 lib/ai-insight.js，避免两份逻辑漂移。
// Netlify 打包时（zip-it-and-ship-it）会跟随 require 把 lib/ 一起带上。
//
// 平仄/韵部查询不走这里 —— 那已改为浏览器本地查表（结果/pingze-engine.js），
// 本接口只负责「查询完成后的 AI 平仄分析与诗词鉴赏」，两个功能由 type 区分，
// 默认关闭、仅前端勾选后才调用；服务端在此再次校验登录与配额。
//
// 安全（2026-10-16 上线前审查）：
//   · 登录校验（lib/ai-insight.js）—— 未登录 401。
//   · 配额 fail-closed —— 记账不确定一律拒绝，不「不扣次数放行调模型」。
//   · IP 级限流（下方）—— 配额管总量，限流管速率。
//   · CORS 收敛为站点自身来源，不再是通配 *。

const store = require('../../lib/supabase-store');
const insight = require('../../lib/ai-insight');
const limiter = require('../../lib/rate-limit');

// AI 接口的 IP 级限流：20 次/分钟/IP。
// 免费用户一天总共 3 次、会员 10 次，故 20/分钟对真人宽松、对脚本 abusive。
const AI_RATE_LIMIT = 20;
const AI_RATE_WINDOW_MS = 60 * 1000;

// CORS 只允许本站来源（2026-10-16 安全审查 P2-2）。
// 鉴权走 Authorization 头而非 cookie，本来就没有 CSRF 风险；
// 收敛来源只是减少被任意站点探测的噪声面，不是必需的安全边界。
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pingze.site';

// 冷调用时把容器启动时间也计入超时预算（模块加载 ≈ 函数冷启动的开始），
// 避免「budget 从 handler 入口才算、bootstrap 时间不计」导致总时长越过
// 平台硬限时被网关杀成 504 空响应。详见 lib/ai-insight.js 超时预算注释。
const MODULE_LOADED_AT = Date.now();
let coldInvocation = true;

exports.handler = async (event) => {
  const startedAt = coldInvocation ? MODULE_LOADED_AT : Date.now();
  coldInvocation = false;
  const deadline = startedAt + insight.FUNCTION_TIMEOUT_MS;

  // 回显请求 Origin（若它是白名单内的），否则不给 CORS 头。
  const reqOrigin = (event.headers || {}).origin || (event.headers || {}).Origin || '';
  const allowOrigin = reqOrigin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : null;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;

  if (event.httpMethod === 'OPTIONS') {
    const pre = Object.assign({}, headers, {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    if (allowOrigin) pre['Access-Control-Allow-Origin'] = allowOrigin;
    return { statusCode: 204, headers: pre, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST 方法' }) };
  }

  // ---- IP 级限流：放在最前面，被限流的请求不做任何昂贵工作 ----
  const rl = limiter.hit(limiter.ipFromEvent(event), {
    limit: AI_RATE_LIMIT,
    windowMs: AI_RATE_WINDOW_MS,
    prefix: 'ai',
    message: 'AI 请求过于频繁，请稍后再试。平仄与韵部查询不受影响。',
  });
  if (!rl.ok) {
    const h = Object.assign({}, headers, { 'Retry-After': String(rl.retryAfterSec) });
    if (allowOrigin) h['Access-Control-Allow-Origin'] = allowOrigin;
    return {
      statusCode: 429,
      headers: h,
      body: JSON.stringify({ ok: false, status: 429, error: rl.message, retryAfterSec: rl.retryAfterSec }),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求体不是合法 JSON' }) };
  }

  const h = event.headers || {};
  const token = store.extractBearer(h.authorization);
  const user = await store.getUserFromToken(token);

  let out;
  try {
    out = await insight.runInsight({
      type: parsed.type,
      text: parsed.text,
      table: parsed.table,
      user: user,
      deadline: deadline,
    });
  } catch (e) {
    // 兜底：异常细节只进服务端日志，不回传前端
    console.error('[ai-insight] 未捕获异常:', (e && e.stack) || e);
    out = { ok: false, status: 500, error: 'AI 服务异常，请稍后重试。' };
  }

  return { statusCode: out.status || (out.ok ? 200 : 500), headers, body: JSON.stringify(out) };
};
