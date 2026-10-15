'use strict';

/**
 * Supabase 数据访问层（瘦身版）—— 被两个后端共用
 *   · server.local.js                  （本地常驻进程）
 *   · netlify/functions/ai-insight.js  （Serverless 函数）
 *
 * V5 起只保留三件事：REST 通道、JWT 换用户、会员等级查询。
 * 平仄/韵部查询已改为前端本地查表（结果/pingze-engine.js），
 * 不再需要 analysis_cache / analyses / api_usage / poems 任何操作
 * （相关表已在迁移 0007 删除）。AI 配额改走 profiles 轻量列，
 * 逻辑在 lib/ai-insight.js。
 *
 * 只用 Node 18+ 内置能力（fetch），零 npm 依赖。
 * 没配 SUPABASE_URL / SERVICE_KEY 时整体降级为空操作。
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const REST_URL = SUPABASE_URL + '/rest/v1';
const AUTH_URL = SUPABASE_URL + '/auth/v1';

/** 未配置 Supabase 时静默降级 */
const ENABLED = Boolean(SUPABASE_URL && SERVICE_KEY);

// ---------------------------------------------------------------- HTTP

async function restFetch(path, options) {
  const opts = options || {};
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(REST_URL + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch (e) {
      detail = '';
    }
    throw new Error(
      `Supabase REST ${res.status} ${opts.method || 'GET'} ${path}: ${String(detail).slice(0, 300)}`
    );
  }
  const raw = await res.text();
  return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------- 身份

function extractBearer(headerValue) {
  const m = /^Bearer\s+(.+)$/i.exec(String(headerValue || '').trim());
  return m ? m[1] : null;
}

/** 用前端传来的 JWT 换用户信息；失败一律返回 null（等同于访客） */
async function getUserFromToken(token) {
  if (!ENABLED || !token) return null;
  try {
    const res = await fetch(AUTH_URL + '/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? { id: user.id, email: user.email } : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  ENABLED: ENABLED,
  REST_URL: REST_URL,
  extractBearer: extractBearer,
  getUserFromToken: getUserFromToken,
  restFetch: restFetch,
};
