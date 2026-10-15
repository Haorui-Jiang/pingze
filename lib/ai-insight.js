'use strict';

/**
 * lib/ai-insight.js —— AI 平仄分析 / 诗词鉴赏（V5，被两个后端共用）
 *   · server.local.js                  （本地常驻进程，路由 /api/ai-insight）
 *   · netlify/functions/ai-insight.js  （Serverless 函数，同路径）
 *
 * 设计要点（对应 tasks.md D 组）：
 *   1. 前置条件：查表已在浏览器本地完成（结果/pingze-engine.js），
 *      本模块只做「查询之后的增值分析」。查表本身永远免费、不走这里。
 *   2. 两个功能各自独立：analysis（格律分析）/ appreciation（诗词鉴赏），
 *      由前端开关决定调哪个；服务端再次校验 type，不信前端状态。
 *   3. 防浪费：必须登录（JWT 换用户）→ 原子扣减 AI 配额（迁移 0007 的
 *      ai_quota_consume）→ 才调模型。开关关着时前端零请求，
 *      伪造请求也会在服务端被 401/429 拦下。
 *   4. 模型以传入的查表结果为依据，不重新逐字判平仄 —— AI 只做判断与阐释，
 *      平仄数据永远以本地字典为准（这正是 V5 修复「AI 判平仄出错」的核心）。
 *   5. 配额服务故障时放行本次（不能因记账故障挡住功能），模型缺失/超时
 *      等在调模型之前或之中失败，都不扣配额（key 缺失时根本还没扣）。
 */

const store = require('./supabase-store');

// 界面展示名 → API 实际模型 ID（DeepSeek 接口仅接受小写 ID）
const MODEL_ALIAS = {
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4.1-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek-v4-pro',
};
const resolveModel = (n) => MODEL_ALIAS[String(n).trim().toLowerCase()] || n;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = resolveModel(process.env.DEEPSEEK_MODEL || 'DeepSeek-V4.1-Flash');
const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const CHAT_ENDPOINT = /\/chat\/completions$/.test(BASE) ? BASE : BASE + '/chat/completions';

// 函数超时（毫秒）：默认 9s，保证在 Netlify 免费版 10s 硬上限内主动返回
// 结构化错误而不是被平台强杀成空响应；Pro 可设 FUNCTION_TIMEOUT_MS=25000。
const FUNCTION_TIMEOUT_MS = Math.min(
  parseInt(process.env.FUNCTION_TIMEOUT_MS || '9000', 10) || 9000,
  25000
);

/** 文本上限，与前端引擎一致 */
const MAX_LEN = 1000;

/** 功能类型白名单 —— 服务端唯一可信的来源 */
const TYPES = ['analysis', 'appreciation'];

/**
 * 两个系统提示词。共同原则：
 *   · 平仄数据以传入的查表结果为准，模型不得自行改判；
 *   · 纯文本输出，不要 markdown 记号（前端按 <pre> 式排版）；
 *   · 限长，控制 token 成本。
 */
const PROMPTS = {
  analysis:
`你是一位精通《平水韵》与近体诗格律的学者。用户会给出一段诗词/对联文本，以及已由本地字典查表确定的逐字平仄串、句尾韵部与重字信息。请严格依据这些确定数据做格律分析，不要重新逐字判定平仄（以传入数据为准）。

输出格式（纯文本，不要 markdown 记号，总长度 400 字以内）：
一、文体判断：依据句数、每句字数、平仄 pattern 推断文体（五绝/七绝/五律/七律/词/对联/古风）；信息不足就说不构成近体，不要硬套。
二、格律分析：逐句对照古平仄串，指出可能的失律处（粘对、孤平、三平尾、拗救等），写明位置；没有失律就明确说合律。
三、押韵分析：依据各句尾字韵部，判断是否同部押韵、有无失韵；多音字说明取舍。
四、多音字提示：对标注「通」的字，结合上下文建议读音。`,

  appreciation:
`你是一位诗词鉴赏家。用户会给出一段诗词/对联文本，并附平仄与韵部信息供参考（鉴赏正文不必引用）。请写一段简短鉴赏，纯文本、不要 markdown 记号、400 字以内：

一、意境与主旨：作品写了什么，情绪如何。
二、章法与修辞：结构安排、对仗、炼字、用典与警句。
三、总体评价：一两句话收束。

不要修改原作，不要逐字判定平仄，不要过度解读。`,
};

/**
 * 原子「检查 + 扣减」AI 配额（迁移 0007 的 ai_quota_consume）。
 * 未配 Supabase 或 RPC 故障时降级放行，避免记账故障挡住功能。
 */
async function consumeQuota(userId) {
  if (!store.ENABLED || !userId) {
    return { allowed: true, degraded: true, used: 0, quota: 3, remaining: 3 };
  }
  try {
    const rows = await store.restFetch('/rpc/ai_quota_consume', {
      method: 'POST',
      body: { p_user_id: userId },
      prefer: 'return=representation',
    });
    if (!rows || typeof rows.allowed !== 'boolean') {
      return { allowed: true, degraded: true, used: 0, quota: 3, remaining: 3 };
    }
    return rows;
  } catch (e) {
    return { allowed: true, degraded: true, reason: String(e && e.message || e) };
  }
}

/**
 * 主入口：执行一次 AI 赏析。
 * @param {object} input { type, text, table, user }
 *   type     'analysis' | 'appreciation'
 *   text     用户原文（已由前端引擎校验过长度，这里再兜一层）
 *   table    前端查表结果摘要（engine.tableText 的输出）
 *   user     store.getUserFromToken 的返回（未登录为 null）
 * @returns {Promise<{ok:true, content, model, remaining}|{ok:false, status, error, ...}>}
 */
async function runInsight(input) {
  const { type, text, table } = input || {};
  const user = (input || {}).user;

  // 1) 必须登录：AI 是计费功能，查表才免费
  if (!user || !user.id) {
    return { ok: false, status: 401, error: '请先登录后再使用 AI 赏析功能。', needLogin: true };
  }
  if (TYPES.indexOf(type) < 0) {
    return { ok: false, status: 400, error: '未知的 AI 功能类型。' };
  }
  const clean = String(text == null ? '' : text).replace(/[\s\u3000]/g, '');
  if (!clean) {
    return { ok: false, status: 400, error: '请输入要查询的诗词文本。' };
  }
  if (clean.length > MAX_LEN) {
    return { ok: false, status: 400, error: '抱歉，总字数不能超过 ' + MAX_LEN + ' 字。' };
  }
  if (!DEEPSEEK_API_KEY) {
    return {
      ok: false,
      status: 500,
      error: '服务端未配置 DEEPSEEK_API_KEY，AI 赏析暂不可用；平仄与韵部查询不受影响。',
    };
  }

  // 2) 配额：先原子扣减，再调模型（扣减失败不放行以外的任何例外）
  const quota = await consumeQuota(user.id);
  if (!quota.allowed) {
    const isMember = quota.quota >= 10;
    return {
      ok: false,
      status: 429,
      error: isMember
        ? `今日 AI 赏析额度已用尽（${quota.used}/${quota.quota}）。明天再来吧。`
        : `今日免费 AI 赏析额度已用尽（${quota.used}/${quota.quota}）。开通会员后每日可用 10 次。`,
      quota: quota.quota, used: quota.used, remaining: 0, needUpgrade: !isMember,
    };
  }

  // 3) 调模型
  const userContent =
    '【原文】\n' + String(text) +
    '\n\n【查表结果（权威数据，分析时以此为准）】\n' + (table || '（无）');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FUNCTION_TIMEOUT_MS);
    const r = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + DEEPSEEK_API_KEY,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: PROMPTS[type] },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const detail = await r.text();
      return {
        ok: false,
        status: 502,
        error: `AI 服务调用失败（HTTP ${r.status}），请稍后重试。`,
        detail: String(detail).slice(0, 300),
      };
    }
    const data = await r.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!content.trim()) {
      return { ok: false, status: 502, error: 'AI 返回了空内容，请重试（未额外消耗额度以外的费用）。' };
    }
    return {
      ok: true,
      type: type,
      content: content.trim(),
      model: DEEPSEEK_MODEL,
      remaining: typeof quota.remaining === 'number' ? quota.remaining : null,
    };
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    return {
      ok: false,
      status: isTimeout ? 504 : 500,
      error: isTimeout
        ? `AI 响应超时（已等待约 ${Math.round(FUNCTION_TIMEOUT_MS / 1000)} 秒）。请缩短文本或稍后重试。`
        : 'AI 服务异常，请稍后重试。',
    };
  }
}

module.exports = {
  TYPES: TYPES,
  AI_QUOTA_FREE: 3,
  AI_QUOTA_MEMBER: 10,
  DEEPSEEK_MODEL: DEEPSEEK_MODEL,
  FUNCTION_TIMEOUT_MS: FUNCTION_TIMEOUT_MS,
  consumeQuota: consumeQuota,
  runInsight: runInsight,
};
