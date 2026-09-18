// Netlify Function 版注册接口
// 挂载路径：/.netlify/functions/register（经 netlify.toml 的 /api/* 重定向对外为 /api/register）
//
// 与本地 server.local.js 共用 lib/auth.js，逻辑不会两份漂移。
// 环境变量（SUPABASE_URL / SUPABASE_SERVICE_KEY）由 Netlify 站点配置注入。
const authReg = require('../../lib/auth');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, headers, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }),
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST 方法' }) };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求体不是合法 JSON' }) };
  }

  const h = event.headers || {};
  const clientIp = (h['x-forwarded-for'] || h['client-ip'] || '').split(',')[0].trim();

  try {
    const out = await authReg.register(parsed.email, parsed.password, clientIp);
    return { statusCode: out.status, headers, body: JSON.stringify(out.body) };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '注册服务异常', detail: String(e) }),
    };
  }
};
