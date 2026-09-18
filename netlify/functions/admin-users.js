// Netlify Function 版后台用户数据接口（替代 server.local.js 的 /api/admin-users）
// 部署到 Netlify 时由平台以 Serverless 方式运行。
// 挂载路径：/.netlify/functions/admin-users（经 netlify.toml 的 /api/* 映射成 /api/admin-users）
// 与本地 server.local.js 共用同一份 lib/admin.js，避免两份逻辑漂移。

const admin = require('../../lib/admin');

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 GET 方法' }) };
  }

  const h = event.headers || {};
  const authHeader = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  const token = m ? m[1] : null;

  const v = await admin.verifyAdmin(token);
  if (!v.ok) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: '无权限：仅限项目管理员账号', reason: v.reason }),
    };
  }

  try {
    const users = await admin.listUsers();
    return { statusCode: 200, headers, body: JSON.stringify({ count: users.length, users: users }) };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '读取用户数据失败', detail: String(e && e.message || e) }),
    };
  }
};
