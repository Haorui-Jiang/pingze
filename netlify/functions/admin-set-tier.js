// Netlify Function 版：修改用户会员等级（运营人开通 / 降级）
// 挂载路径：/.netlify/functions/admin-set-tier（经 netlify.toml 的 /api/* 映射成 /api/admin-set-tier）
// 与本地 server.local.js 共用 lib/admin.js，鉴权逻辑一致（ADMIN_EMAILS 白名单）。

const admin = require('../../lib/admin');

function bearer(h) {
  const m = /^Bearer\s+(.+)$/i.exec(String((h && (h.authorization || h.Authorization)) || '').trim());
  return m ? m[1] : null;
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST 方法' }) };
  }

  const v = await admin.verifyAdmin(bearer(event.headers));
  if (!v.ok) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: '无权限：仅限项目管理员账号', reason: v.reason }),
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
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: String(e && e.message || e) }),
    };
  }
};
