// Netlify Function 版后台用户数据接口（替代 server.local.js 的 /api/admin-users）
// 部署到 Netlify 时由平台以 Serverless 方式运行。
// 挂载路径：/.netlify/functions/admin-users（经 netlify.toml 的 /api/* 映射成 /api/admin-users）
// 与本地 server.local.js 共用同一份 lib/admin.js，避免两份逻辑漂移。

const admin = require('../../lib/admin');

// CORS 只允许本站来源（2026-10-16 安全审查 P2-2）。
// 鉴权走 Authorization 头而非 cookie，本来没有 CSRF 风险；
// 收敛来源只是减少后台接口被任意站点探测的噪声面。
// 管理接口不应被第三方站点读取，也不应被浏览器跨源调用。
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pingze.site';

exports.handler = async function (event) {
  const reqOrigin = (event.headers || {}).origin || (event.headers || {}).Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  // 只在请求来源确实是本站时才回显（后台页与本站同源，故始终命中）
  if (reqOrigin === ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = reqOrigin;

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 GET 方法' }) };
  }

  const h = event.headers || {};
  const authHeader = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  const token = m ? m[1] : null;

  const v = await admin.verifyAdmin(token);
  if (!v.ok) {
    // 只回显**已知的原因码**（便于后台页区分「未登录 / 令牌失效 / 非管理员」）。
    // 未知原因（'error: ...' 带内部信息）一律归一为 'error'，不外传。
    const KNOWN = ['no-auth', 'invalid-token', 'no-admins-configured', 'not-admin'];
    const reason = KNOWN.indexOf(v.reason) >= 0 ? v.reason : 'error';
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: '无权限：仅限项目管理员账号', reason: reason }),
    };
  }

  try {
    const users = await admin.listUsers();
    return { statusCode: 200, headers, body: JSON.stringify({ count: users.length, users: users }) };
  } catch (e) {
    // 细节已由 lib/admin.js 写进服务端日志，这里不回传（P2-3）
    console.error('[admin-users] 读取用户数据失败:', (e && e.stack) || e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '读取用户数据失败，请稍后重试。' }),
    };
  }
};
