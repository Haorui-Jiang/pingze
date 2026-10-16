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

const store = require('../../lib/supabase-store');
const insight = require('../../lib/ai-insight');

// 冷调用时把容器启动时间也计入超时预算（模块加载 ≈ 函数冷启动的开始），
// 避免「budget 从 handler 入口才算、bootstrap 时间不计」导致总时长越过
// 平台硬限时被网关杀成 504 空响应。详见 lib/ai-insight.js 超时预算注释。
const MODULE_LOADED_AT = Date.now();
let coldInvocation = true;

exports.handler = async (event) => {
  const startedAt = coldInvocation ? MODULE_LOADED_AT : Date.now();
  coldInvocation = false;
  const deadline = startedAt + insight.FUNCTION_TIMEOUT_MS;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, headers, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  const token = store.extractBearer(h.authorization);
  const user = await store.getUserFromToken(token);

  const out = await insight.runInsight({
    type: parsed.type,
    text: parsed.text,
    table: parsed.table,
    user: user,
    deadline: deadline,
  });

  return { statusCode: out.status || (out.ok ? 200 : 500), headers, body: JSON.stringify(out) };
};
