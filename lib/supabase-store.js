'use strict';

/**
 * Supabase 数据访问层 —— 被两个后端共用
 *   · server.local.js                 （本地 / Railway 常驻进程）
 *   · netlify/functions/analyze.js    （Serverless 函数）
 *
 * 只用 Node 18+ 内置能力（crypto / fetch），不引入任何 npm 依赖，
 * 保持整个项目「零依赖」的现状。
 *
 * 设计约束：
 *   1. 缓存命中不消耗配额 —— 命中本来就是零成本的
 *   2. 所有记账类写失败都必须吞掉，绝不能因为写日志把分析结果给丢了
 *   3. 没配 SUPABASE_URL / SERVICE_KEY 时整体降级为空操作，旧行为不受影响
 */

const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const REST_URL = SUPABASE_URL + '/rest/v1';
const AUTH_URL = SUPABASE_URL + '/auth/v1';

/** 未配置 Supabase 时整套功能静默降级，保证原有分析链路照常工作 */
const ENABLED = Boolean(SUPABASE_URL && SERVICE_KEY);

/**
 * 引擎版本号 —— 改了 SYS_PROMPT 或换了模型必须升级这里。
 * input_hash 会带上它，旧口径的缓存随之自动失效。
 * 忘了改的后果：用户拿到的仍是按旧 prompt 生成的答案。
 */
const ENGINE = 'deepseek';
const ENGINE_VERSION = '2026-09-13-1';

/**
 * 是否强制「登录才能分析」。
 * 未显式配置时，配了 Supabase 就要求登录 —— 这是默认值，因为算力和 token 都是真金白银。
 * 想放开匿名使用就设 REQUIRE_LOGIN=0（此时 ANON_DAILY_QUOTA 生效）。
 */
const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN
  ? /^(1|true|yes)$/i.test(process.env.REQUIRE_LOGIN)
  : ENABLED;

const ANON_DAILY_QUOTA = Number(process.env.ANON_DAILY_QUOTA || 5);

/**
 * 会员体系（付费功能）每日配额 —— 与数据库 usage_today() 必须保持一致：
 *   free   → 1  次/天
 *   member → 10 次/天（且会员未过期）
 * 改这里必须同步改 supabase/0006_membership.sql 的 usage_today()，
 * 否则会出现「前端显示 1、后端按 10 放行」的错配。
 */
const QUOTA_BY_TIER = {
  free: Number(process.env.QUOTA_FREE || 1),
  member: Number(process.env.QUOTA_MEMBER || 10),
};
const TIER_FREE = 'free';
const TIER_MEMBER = 'member';

// 中国全境固定 UTC+8，无夏令时，可以直接加偏移量取「北京时间的今天 0 点」
const SH_OFFSET_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 基础工具

function normalizeText(text) {
  // 与 V4.2 一致：半角/全角空格与 Tab 不参与语义，哈希前一律剔除
  return String(text || '').replace(/[\s\u3000]+/g, '');
}

function computeInputHash(parts) {
  const payload = [
    normalizeText(parts.text),
    parts.rhymeBook || 'pingshui',
    parts.mode || 'both',
    ENGINE,
    ENGINE_VERSION,
    parts.model || '',
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 北京时间当日 00:00 对应的 UTC 时刻（ISO 串）。
 * 直接用 UTC 自然日的话，配额会在北京时间早八点突然清零。
 */
function shanghaiMidnightISO() {
  const shNow = new Date(Date.now() + SH_OFFSET_MS);
  const utcOfMidnight =
    Date.UTC(shNow.getUTCFullYear(), shNow.getUTCMonth(), shNow.getUTCDate()) - SH_OFFSET_MS;
  return new Date(utcOfMidnight).toISOString();
}

/** 未登录访客的配额桶：IP + UA 哈希，够用且不留明文 IP */
function anonymousActorKey(ip, userAgent) {
  const raw = `${ip || 'unknown'}|${(userAgent || '').slice(0, 200)}`;
  return 'anon-' + crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}

function extractBearer(headerValue) {
  const m = /^Bearer\s+(.+)$/i.exec(String(headerValue || '').trim());
  return m ? m[1] : null;
}

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

// ---------------------------------------------------------------- 配额

/**
 * 统计今日已用额度。
 *
 * 关键：必须按 status 过滤，只数真正花了钱的 ok / timeout。
 *   · cache_hit      —— 零成本，不计数（否则用户看缓存也要消耗额度）
 *   · quota_exceeded —— 拒绝事件，只做运营观测，不计数
 *     不排除的话，用户每重试一次被拒就要多计一次，界面会出现「已用 9 / 上限 5」
 */
async function countUsageToday(where) {
  const params = new URLSearchParams();
  Object.keys(where || {}).forEach((k) => params.set(k, where[k]));
  params.set('select', 'id');
  params.set('limit', '0');
  params.set('created_at', 'gte.' + shanghaiMidnightISO());
  params.set('status', 'in.(ok,timeout)');

  const res = await fetch(REST_URL + '/api_usage?' + params.toString(), {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      Prefer: 'count=exact',
    },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch (e) {
      detail = '';
    }
    throw new Error(`配额统计失败 ${res.status}: ${String(detail).slice(0, 300)}`);
  }
  const range = res.headers.get('content-range') || '';
  const total = range.split('/')[1];
  return total && total !== '*' ? Number(total) : 0;
}

/**
 * 返回 { allowed, used, quota, actorKey, tier }
 * 只统计真正花了钱的状态（ok / timeout）；cache_hit 不计入配额。
 * quota 按用户会员等级计算：free=1 / member=10。
 */
async function checkQuota(user, actorKey) {
  if (!ENABLED) return { allowed: true, used: 0, quota: Infinity, actorKey, tier: TIER_FREE };
  const key = user ? user.id : actorKey;
  const where = user ? { user_id: 'eq.' + key } : { actor_key: 'eq.' + key };
  const used = await countUsageToday(where);
  // 匿名访客没有档案，用固定匿名额度；登录用户按其会员等级
  let quota, tier;
  if (user) {
    const info = await getMembership(user.id);
    tier = info.tier;
    quota = info.quota;
  } else {
    tier = null;
    quota = ANON_DAILY_QUOTA;
  }
  return { allowed: used < quota, used: used, quota: quota, actorKey: key, tier: tier };
}

/**
 * 读取用户会员信息，返回 { tier, quota, memberSince, memberExpiresAt, active }。
 *   · tier 只有 'member' 且 member_expires_at 未过期时，才算有效会员 → quota = QUOTA_BY_TIER.member
 *   · 其余（含已过期）一律按 free 计
 * 查不到档案时保守回落到 free，宁可不给额度也不误放。
 */
async function getMembership(userId) {
  const fallback = {
    tier: TIER_FREE,
    quota: QUOTA_BY_TIER[TIER_FREE],
    memberSince: null,
    memberExpiresAt: null,
    active: false,
  };
  if (!ENABLED || !userId) return fallback;
  try {
    const rows = await restFetch(
      '/profiles?select=tier,member_since,member_expires_at&id=eq.' + userId + '&limit=1'
    );
    if (!rows || !rows.length) return fallback;
    const p = rows[0];
    const expires = p.member_expires_at ? new Date(p.member_expires_at) : null;
    const active = p.tier === TIER_MEMBER && expires && expires.getTime() > Date.now();
    return {
      tier: p.tier || TIER_FREE,
      quota: active ? QUOTA_BY_TIER[TIER_MEMBER] : QUOTA_BY_TIER[TIER_FREE],
      memberSince: p.member_since || null,
      memberExpiresAt: p.member_expires_at || null,
      active: Boolean(active),
    };
  } catch (e) {
    // 读档案失败不能让分析瘫掉，按 free 保守放行 1 次即可（额度仍会被记录）
    return fallback;
  }
}

/** 兼容旧调用：按等级取每日额度 */
async function getDailyQuota(userId) {
  const m = await getMembership(userId);
  return m.quota;
}

// ---------------------------------------------------------------- 缓存

async function findCached(hash) {
  const rows = await restFetch('/analysis_cache?select=*&input_hash=eq.' + hash + '&limit=1');
  if (!rows || !rows.length) return null;
  const row = rows[0];
  // 命中计数：失败无所谓，不该影响主流程
  restFetch('/analysis_cache?input_hash=eq.' + hash, {
    method: 'PATCH',
    body: { hit_count: (row.hit_count || 0) + 1, last_hit_at: new Date().toISOString() },
  }).catch(() => {});
  return row;
}

async function saveCache(row) {
  try {
    const inserted = await restFetch('/analysis_cache', {
      method: 'POST',
      body: row,
      prefer: 'return=representation',
    });
    return inserted && inserted[0] ? inserted[0].id : null;
  } catch (e) {
    // 并发写入可能撞 unique(input_hash)，退回去读一次
    try {
      const rows = await restFetch(
        '/analysis_cache?select=id&input_hash=eq.' + row.input_hash + '&limit=1'
      );
      return rows && rows[0] ? rows[0].id : null;
    } catch (e2) {
      return null;
    }
  }
}

// ---------------------------------------------------------------- 记账（失败一律吞掉）

function swallow(label, fn) {
  return function () {
    try {
      return Promise.resolve(fn.apply(null, arguments)).then(
        () => null,
        (e) => {
          console.warn('[sb] ' + label + ' 写入失败:', e && e.message);
          return null;
        }
      );
    } catch (e) {
      console.warn('[sb] ' + label + ' 同步异常:', e && e.message);
      return Promise.resolve(null);
    }
  };
}

const recordUsage = swallow('api_usage', async function recordUsageImpl(row) {
  if (!ENABLED) return null;
  return restFetch('/api_usage', { method: 'POST', body: row });
});

const recordAnalysis = swallow('analyses', async function recordAnalysisImpl(row) {
  if (!ENABLED) return null;
  return restFetch('/analyses', { method: 'POST', body: row });
});

module.exports = {
  ENABLED: ENABLED,
  REQUIRE_LOGIN: REQUIRE_LOGIN,
  ENGINE: ENGINE,
  ENGINE_VERSION: ENGINE_VERSION,
  ANON_DAILY_QUOTA: ANON_DAILY_QUOTA,
  QUOTA_BY_TIER: QUOTA_BY_TIER,
  TIER_FREE: TIER_FREE,
  TIER_MEMBER: TIER_MEMBER,
  normalizeText: normalizeText,
  computeInputHash: computeInputHash,
  anonymousActorKey: anonymousActorKey,
  extractBearer: extractBearer,
  getUserFromToken: getUserFromToken,
  checkQuota: checkQuota,
  countUsageToday: countUsageToday,
  getDailyQuota: getDailyQuota,
  getMembership: getMembership,
  findCached: findCached,
  saveCache: saveCache,
  recordUsage: recordUsage,
  recordAnalysis: recordAnalysis,
};
