// Netlify Function 版：修改用户会员等级（运营人开通 / 降级）
// 挂载路径：/.netlify/functions/admin-set-tier（经 netlify.toml 的 /api/* 映射成 /api/admin-set-tier）
// 与本地 server.local.js 共用 lib/admin.js，鉴权逻辑一致（ADMIN_EMAILS 白名单）。

const admin = require('../../lib/admin');

// CORS 只允许本站来源（2026-10-16 安全审查 P2-2）。
// 这是**写操作**（改会员等级），比只读接口更应收紧。
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pingze.site';

function bearer(h) {
  const m = /^Bearer\s+(.+)$/i.exec(String((h && (h.authorization || h.Authorization)) || '').trim());
  return m ? m[1] : null;
}

exports.handler = async function (event) {
  const reqOrigin = (event.headers || {}).origin || (event.headers || {}).Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (reqOrigin === ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = reqOrigin;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST 方法' }) };
  }

  const v = await admin.verifyAdmin(bearer(event.headers));
  if (!v.ok) {
    const KNOWN = ['no-auth', 'invalid-token', 'no-admins-configured', 'not-admin'];
    const reason = KNOWN.indexOf(v.reason) >= 0 ? v.reason : 'error';
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: '无权限：仅限项目管理员账号', reason: reason }),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求体不是合法 JSON' }) };
  }

  try {
    const out = await admin.setTier(parsed.userId, parsed.tier, parsed.days);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, user: out, operator: v.email }),
    };
  } catch (e) {
    // setTier 的校验错误（tier 非法 / userId 非 UUID / 找不到档案）是
    // 面向管理员的**人话**，回传没问题；其余细节已由 lib/admin.js 记进日志。
    const msg = String((e && e.message) || e);
    const safe = /tier 只能是|不是合法 UUID|未找到该用户档案/.test(msg)
      ? msg
      : '操作失败，请稍后重试。';
    if (safe !== msg) console.error('[admin-set-tier] 操作失败:', (e && e.stack) || e);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: safe }),
    };
  }
};
