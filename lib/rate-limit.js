'use strict';

/**
 * lib/rate-limit.js —— 进程内 IP 级限流（被两个后端共用）
 *   · server.local.js                 （本地常驻进程）
 *   · netlify/functions/ai-insight.js  （Serverless 函数）
 *
 * 为什么需要它（2026-10-16 上线前安全审查 P1-1）：
 *   AI 赏析是本项目**唯一花钱的接口**。它原本只有「每日配额」一道护栏，
 *   没有频率限制 —— 单个账号可以在配额耗尽前把 3 次/10 次瞬间打完，
 *   也可以高并发压接口。一旦配合记账 fail-open 放行，就是无限白嫖。
 *   配额管「总量」，限流管「速率」，两道都要有。
 *
 * 设计取舍（先讲清楚局限，避免误以为它是银弹）：
 *   · 这是**进程内**计数。Netlify Serverless 实例是短生命周期的、
 *     同一请求可能命中不同实例，故它只能压住「单实例上的突发」，
 *     压不住「分布式缓慢爬坡」。这是刻意的取舍：本项目追求零依赖，
 *     引入 Redis/Upstash 会增加一个外部故障点和一份账单。
 *   · 要真正做到分布式限流，把 checkRateLimit 换成读 Redis 即可，
 *     调用方无需改动（接口刻意保持只有 hit() 一个方法）。
 *   · 单实例内存计数对「同一 IP 短时间狂刷」这种最常见的滥用形态
 *     是有效的，而那正是攻击脚本的行为特征。
 *
 * 用法：
 *   const limiter = require('../../lib/rate-limit');
 *   const verdict = limiter.hit(reqIp, { limit: 10, windowMs: 60000 });
 *   if (!verdict.ok) return 429 + { error: verdict.message };
 */

const DEFAULTS = {
  limit: 10,          // 窗口内允许的次数
  windowMs: 60000,    // 窗口长度（毫秒）
  prefix: 'rl',       // 键前缀，多个限流器互不干扰
};

// Map<key, { count, resetAt }>
const buckets = new Map();
// 上次清理时间，避免每次调用都遍历全表
let lastSweep = Date.now();
// 清理间隔：窗口长度的量级即可，不必频繁
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** 清理已过期的桶，防止 Map 无限增长（IP 可以是任意伪造值） */
function sweep(now) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/**
 * 取客户端 IP。
 * Netlify 会把真实 IP 放在 x-nf-client-connection-ip（由平台注入，
 * 客户端无法伪造 —— 这是 Netlify 文档保证的字段）；
 * 其次退化到 x-forwarded-for 的第一段与 x-real-ip。
 * @returns {string} 取不到时返回 'unknown'（所有 unknown 共享一个桶，
 *                   属于「宁可误伤也不放过」的保守默认）
 */
function clientIp(req) {
  if (!req) return 'unknown';
  const headers = (req.headers || {});
  const get = (k) => {
    const v = headers[k] !== undefined ? headers[k] : headers[String(k).toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const nf = get('x-nf-client-connection-ip') || get('x-nf-client-connection-ipv6');
  if (nf) return String(nf).trim();
  const xff = get('x-forwarded-for');
  if (xff) return String(xff).split(',')[0].trim();
  const real = get('x-real-ip');
  if (real) return String(real).trim();
  return 'unknown';
}

/**
 * 固定窗口计数器。命中返回 { ok, remaining, retryAfterSec, limit, message }。
 * 未命中返回 { ok: true, remaining, limit }。
 *
 * @param {string} ip  客户端 IP（用 clientIp 取，不要信请求体）
 * @param {object} opts { limit, windowMs, prefix, message }
 */
function hit(ip, opts) {
  const o = opts || {};
  const limit = Number(o.limit) || DEFAULTS.limit;
  const windowMs = Number(o.windowMs) || DEFAULTS.windowMs;
  const prefix = o.prefix || DEFAULTS.prefix;

  const now = Date.now();
  sweep(now);

  const key = prefix + '|' + (ip || 'unknown');
  let b = buckets.get(key);
  // 窗口已过 → 重开一个
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }

  b.count += 1;
  if (b.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return {
      ok: false,
      limit: limit,
      remaining: 0,
      retryAfterSec: retryAfterSec,
      message:
        o.message ||
        '请求过于频繁，请稍后再试（约 ' + retryAfterSec + ' 秒后可重试）。',
    };
  }
  return { ok: true, limit: limit, remaining: limit - b.count };
}

/**
 * 把 Netlify 事件对象（event.headers）包装成 req 供 clientIp 使用。
 * Serverless 函数里没有 req，只有 event。
 */
function ipFromEvent(event) {
  return clientIp({ headers: (event && event.headers) || {} });
}

/** 仅供测试：清空所有计数 */
function reset() {
  buckets.clear();
  lastSweep = Date.now();
}

module.exports = {
  DEFAULTS: DEFAULTS,
  hit: hit,
  clientIp: clientIp,
  ipFromEvent: ipFromEvent,
  reset: reset,
};
