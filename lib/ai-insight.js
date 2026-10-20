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
 *   5. 配额是**唯一花钱的护栏**，故 2026-10-16 安全审查后改为 **fail-closed**：
 *      记账（Supabase 往返）任何不确定的失败一律拒绝本次请求，绝不「不扣次数
 *      放行去调模型」—— 那是可被并发压测主动触发的免费白嫖通道。
 *      配套进程内熔断器，避免故障期间每次请求都等满超时预算。
 *      配额在调模型之前原子扣减 —— 模型超时/失败也已扣次（防重试循环烧钱），
 *      key 缺失时根本还没扣。
 *   6. 超时是「全函数总预算」（2026-10-16 504 事故后重写）：调用方在入口
 *      传入 deadline，冷调用把容器启动时间也计入；任何阶段超时都在平台
 *      杀进程之前返回结构化 504，前端拿到的是人话而不是空响应。
 *   7. 上游模型返回的错误原文只写服务端日志，不进响应体（P2-3）。
 */

const store = require('./supabase-store');

// 界面展示名 → API 实际模型 ID（DeepSeek 接口仅接受小写 ID）
const MODEL_ALIAS = {
  'deepseek-chat': 'deepseek-chat',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4.1-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek-v4-pro',
};
const resolveModel = (n) => MODEL_ALIAS[String(n).trim().toLowerCase()] || n;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
// 默认模型 = deepseek-chat（2026-10-16 线上 504 事故后调整，见下方超时预算注释）：
//   · deepseek-flash（V4.1-Flash）是「推理型」模型：每次先输出 2000-4000 个
//     reasoning tokens 才给正文，单次耗时 14-26s（沙箱实测），从 Netlify
//     函数出网更是 22-26s，频繁越过 Serverless 时限被网关杀成 504 空响应。
//   · deepseek-chat 为非推理型：同题 1.6s 返回、内容完整，故作默认模型。
// 需要更强推理时设 DEEPSEEK_MODEL=deepseek-flash，并同步调大
// FUNCTION_TIMEOUT_MS 与 PLATFORM_LIMIT_MS（见下方超时预算）。
const DEEPSEEK_MODEL = resolveModel(process.env.DEEPSEEK_MODEL || 'deepseek-chat');
const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const CHAT_ENDPOINT = /\/chat\/completions$/.test(BASE) ? BASE : BASE + '/chat/completions';

// ---- 超时预算（2026-10-16 重写：从「只包模型调用」改为「全函数总预算」）----
// 旧实现的坑：AbortController 只包住 DeepSeek 的 fetch，且计时从 fetch 开始
// ——冷启动 + 两次 Supabase 往返不计入，总时长 = 开销 + 9s，轻易越过
// Netlify 免费版 10s 硬限时，被平台网关杀成 504 空响应（前端只能显示
// 「AI 没有返回内容」，因为响应体根本不是 JSON，r.json() 直接失败）。
// 新口径：
//   · 调用方（函数 handler 入口）传入 deadline（绝对时刻 ms，冷调用从模块
//     加载时刻算起，把容器启动时间也计入预算）；
//   · 每个阶段只花剩余预算的一小份，模型调用拿剩下的大头；
//   · 总预算 = min(FUNCTION_TIMEOUT_MS, PLATFORM_LIMIT_MS - 安全余量)，
//     保证任何情况下都在平台杀进程之前返回结构化 JSON 错误。
const PLATFORM_LIMIT_MS = Math.max(
  6000,
  parseInt(process.env.PLATFORM_LIMIT_MS || '10000', 10) || 10000
);
const FUNCTION_TIMEOUT_MS = Math.min(
  parseInt(process.env.FUNCTION_TIMEOUT_MS || '8000', 10) || 8000,
  PLATFORM_LIMIT_MS - 500
);
// 留给 JSON 序列化 / 平台开销的余量
const RESERVE_MS = 600;

/** 给 Promise 加超时：到点抛 Error('TIMEOUT:<label>')，并清理定时器 */
function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return Promise.resolve(promise);
  let timer = null;
  const tp = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT:' + label)), ms);
  });
  // 原始 promise 稍后才失败时不要触发 unhandledRejection
  promise.catch(() => {});
  return Promise.race([promise, tp]).finally(() => clearTimeout(timer));
}

/** 超时统一出口：结构化 504，前端可显示人话 */
function timeoutResult(startedAt) {
  const waited = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  return {
    ok: false,
    status: 504,
    error: 'AI 响应超时（已等待约 ' + waited + ' 秒）。请缩短文本或稍后重试；平仄与韵部查询不受影响。',
  };
}

// ---- 入参长度护栏（2026-10-20 上线前安全审查 P1-1 修复）----
//
// 旧实现的漏洞：**校验的字符串与发给模型的字符串不是同一个**。
//   const clean = String(text).replace(/[\s\u3000]/g, '');   // 校验用这个
//   if (clean.length > MAX_LEN) ...                          // 只看去空白后的字数
//   const userContent = '【原文】\n' + String(text) + ...;    // 发给模型用这个（原始值）
// 于是 `text = '床前明月光' + ' '.repeat(60000)` 的 clean.length = 5，通过校验，
// 但实际送进 DeepSeek 的是 60005 字符 → token 花费没有任何上限约束。
// 更严重的是 `table` 参数**完全不校验长度**：它正常只有几百字
// （pingze-engine.js 的 tableText 每句一行），但可以构造到任意大小。
//
// AI 是本项目唯一花钱的接口，配额（3 次/天）只管「次数」不管「单次大小」，
// 两者一乘就是可放大的账单。所以这里对**真正要发出去的每一个字段**设硬上限。
//
// 口径说明（别与前端引擎混淆，三处不是同一件事）：
//   MAX_LEN      有效字数上限，与 结果/pingze-engine.js 的 MAX_LEN 一致（清洗后口径）
//   MAX_RAW_LEN  原始 text 的字节长度上限：清洗会删掉空白/标点，
//                故清洗后的合法输入其原始值可能略超 MAX_LEN（含换行分句符）。
//                留 2 倍余量既能覆盖正常输入，又能挡住「空白撑长度」的绕过。
//   MAX_TABLE_LEN 查表摘要上限：1000 字文本在「每句一行 + 逐句平仄串」的格式下
//                约 1.2 万字符，取 20000 留足余量；正常诗词实际只有几百到几千。
const MAX_LEN = 1000;
const MAX_RAW_LEN = 2000;
const MAX_TABLE_LEN = 20000;

/** 功能类型白名单 —— 服务端唯一可信的来源。
 *  取值必须与 DB 迁移里 query_insights.kind 的 check 约束、
 *  前端 AI_KIND_LABEL 三方一致，改一处必须同步三处。 */
const TYPES = ['analysis', 'appreciation', 'translation'];/**
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

  translation:
`你是一位古典文学译者，擅长把文言诗词译成通俗易懂的白话文。用户会给出一段中文诗词/对联文本。请把它翻译成现代汉语白话，纯文本、不要 markdown 记号、400 字以内：

一、逐句译文：按原顺序逐句翻译，一句对一句，不要漏句、不要增删句。保留原文中的人名、地名、典故名（可在括号内补一句极短解释）。
二、疑难字词注释：挑出直译会失真的字词（通假字、词类活用、倒装、省略、双关），用一句话说明它在原句里的意思。
三、译文要点：用两三句话点明全诗的主旨情绪。

要求：
· 只做白话翻译，不要另加英文、日文或其他外语译文。
· 不要逐字判定平仄，不要评价格律优劣（平仄与韵部信息仅供参考，无需引用）。
· 译文要准确传意，宁可朴素，不要为了文采而增译原文没有的内容。
· 保留原文的换行分句，便于用户对照阅读。`,
};

// ---- 记账熔断器（fail-closed 的配套，2026-10-16 上线前安全审查 P1-1）----
//
// 问题：`consumeQuota` 原本在 Supabase 超时/报错时返回 allowed:true 直接放行。
// 这是「记账失败即免费」的 fail-open —— AI 是本项目唯一花钱的接口，
// 攻击者只要并发压接口把 Supabase 打成慢响应，记账就大面积失效，
// 于是可以无计数地消耗 DeepSeek 额度。
//
// 现在改成 **fail-closed**：记账失败一律拒绝本次请求（503）。
// 代价是 Supabase 抖动时 AI 功能短暂不可用，但 AI 是查表之后的增值功能，
// 挡住它不影响平仄/韵部查询这个核心主功能 —— 用一点可用性换账单安全，
// 在花钱接口上是值得的。
//
// 熔断器的作用：fail-closed 若每次都真的打 Supabase，故障期间会把
// 「每次请求都等 5 秒超时」放大成雪崩。连续失败达到阈值就短路一段时间，
// 直接拒答不再打网络，故障恢复后自动半开重试。
const BREAKER_THRESHOLD = 3;        // 连续失败多少次后熔断
const BREAKER_WINDOW_MS = 30000;    // 熔断持续时长
let consecutiveFailures = 0;
let breakerOpenedAt = 0;

/** 熔断器是否处于打开（拒绝一切记账）状态 */
function breakerOpen() {
  if (!breakerOpenedAt) return false;
  // 熔断窗口已过 → 半开：清零计数，下一次失败会重新熔断
  if (Date.now() - breakerOpenedAt > BREAKER_WINDOW_MS) {
    breakerOpenedAt = 0;
    consecutiveFailures = 0;
    return false;
  }
  return true;
}

function noteSuccess() {
  consecutiveFailures = 0;
  breakerOpenedAt = 0;
}

function noteFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) breakerOpenedAt = Date.now();
}

/**
 * 原子「检查 + 扣减」AI 配额（迁移 0007 的 ai_quota_consume）。
 *
 * ★ fail-closed（2026-10-16 安全审查 P0/P1 修复）：
 *   任何不确定的情形（未配置 Supabase、RPC 报错、超时、返回结构异常、
 *   熔断器打开）**一律拒绝**，绝不返回 allowed:true。
 *   唯一放行的是「RPC 明确返回 allowed:false」这一种确定的额度耗尽。
 *
 * @param userId 本次用户（必须已登录）
 * @param budgetMs 本次允许花费的最大毫秒数（由总预算分配）
 * @returns {{ok:true, allowed:boolean, ...}|{ok:false, status:503, error:string}}
 *          ok:true  → 可以继续调模型；ok:false → 直接把该结果返回给调用方
 */
async function consumeQuota(userId, budgetMs) {
  const failClosed = (reason) => ({
    ok: false,
    status: 503,
    error:
      'AI 配额服务暂时不可用，请稍后重试（为避免重复计费，本次请求未执行）。' +
      '平仄与韵部查询不受影响。',
    reason: reason,
  });

  // 没配 Supabase：这是配置错误，绝不能当成「不扣次数随便用」
  if (!store.ENABLED || !userId) {
    return failClosed('supabase-not-configured');
  }

  // 熔断中：不打网络，直接拒答，避免故障期间把每次请求都拖满超时预算
  if (breakerOpen()) {
    return failClosed('breaker-open');
  }

  let rows;
  try {
    rows = await withTimeout(
      store.restFetch('/rpc/ai_quota_consume', {
        method: 'POST',
        body: { p_user_id: userId },
        prefer: 'return=representation',
      }),
      budgetMs,
      'quota'
    );
  } catch (e) {
    noteFailure();
    // 仅写服务端日志，不回传细节（避免把内部错误暴露给调用方）
    console.error('[ai-insight] 配额扣减失败（fail-closed）:', String((e && e.message) || e));
    return failClosed('quota-rpc-error');
  }

  // 返回结构异常同样视为不确定 → fail-closed。
  // 只有明确拿到布尔值才认为结果可信。
  if (!rows || typeof rows.allowed !== 'boolean') {
    noteFailure();
    console.error('[ai-insight] 配额返回结构异常（fail-closed）:', JSON.stringify(rows));
    return failClosed('quota-bad-shape');
  }

  noteSuccess();
  return { ok: true, allowed: rows.allowed, used: rows.used, quota: rows.quota, remaining: rows.remaining };
}

/**
 * 主入口：执行一次 AI 赏析。
 * @param {object} input { type, text, table, user, deadline }
 *   type     'analysis' | 'appreciation'
 *   text     用户原文（已由前端引擎校验过长度，这里再兜一层）
 *   table    前端查表结果摘要（engine.tableText 的输出）
 *   user     store.getUserFromToken 的返回（未登录为 null）
 *   deadline 全函数总预算的终点（绝对时刻 ms，调用方在入口算好传入；
 *            冷调用应把容器启动时间也计入）。缺省时自算。
 * @returns {Promise<{ok:true, content, model, remaining}|{ok:false, status, error, ...}>}
 */
async function runInsight(input) {
  const startedAt = Date.now();
  const { type, text, table } = input || {};
  const user = (input || {}).user;
  const deadline =
    input && typeof input.deadline === 'number'
      ? input.deadline
      : startedAt + FUNCTION_TIMEOUT_MS;
  const remaining = () => Math.max(0, deadline - Date.now());

  // 1) 必须登录：AI 是计费功能，查表才免费
  if (!user || !user.id) {
    return { ok: false, status: 401, error: '请先登录后再使用 AI 赏析功能。', needLogin: true };
  }
  if (TYPES.indexOf(type) < 0) {
    return { ok: false, status: 400, error: '未知的 AI 功能类型。' };
  }

  // 入参长度护栏（P1-1）：**校验的对象必须与发送的对象同一个**。
  //   rawText / rawTable 是真正会被拼进 prompt 的值，先各自设硬上限，
  //   再用 clean 做业务层的「有效字数」判断，两者不能互相替代 ——
  //   只看 clean 就是本次审查修掉的绕过（空白撑长度）。
  const rawText = String(text == null ? '' : text);
  const rawTable = table == null ? '' : String(table);
  if (rawText.length > MAX_RAW_LEN) {
    return {
      ok: false,
      status: 400,
      error: '文本过长（含空白与标点共 ' + rawText.length + ' 字符，上限 ' + MAX_RAW_LEN + '），请删减后再试。',
    };
  }
  if (rawTable.length > MAX_TABLE_LEN) {
    // table 由前端本地查表生成，正常只有几百字。超长说明不是本站页面发出来的
    // —— 直接拒，不要截断：截断会让模型拿到残缺的逐句平仄数据而误判格律。
    return {
      ok: false,
      status: 400,
      error: '查表数据异常（长度 ' + rawTable.length + '，上限 ' + MAX_TABLE_LEN + '），请重新查询后再试。',
    };
  }
  const clean = rawText.replace(/[\s\u3000]/g, '');
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

  // 2) 配额：先原子扣减，再调模型。
  //    fail-closed：记账失败不调模型（详见 consumeQuota 上方注释）。
  const quotaRes = await consumeQuota(user.id, Math.min(store.SUPABASE_TIMEOUT_MS, remaining() - RESERVE_MS));
  if (!quotaRes.ok) {
    // 503：配额服务不可用，本次不放行
    return { ok: false, status: quotaRes.status, error: quotaRes.error, reason: quotaRes.reason };
  }
  const quota = quotaRes;
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

  // 3) 调模型：只拿「剩余预算 - 安全余量」；超时统一走 timeoutResult
  // ★ 这里必须用上面已校验过长度的 rawText / rawTable，**不要退回读入参
  //   text / table** —— 那样就又回到「校验一份、发另一份」的老漏洞。
  const userContent =
    '【原文】\n' + rawText +
    '\n\n【查表结果（权威数据，分析时以此为准）】\n' + (rawTable || '（无）');

  const modelBudget = remaining() - RESERVE_MS;
  if (modelBudget <= 0) return timeoutResult(startedAt);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), modelBudget);
    let r;
    try {
      r = await fetch(CHAT_ENDPOINT, {
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
    } finally {
      clearTimeout(timer);
    }

    if (!r.ok) {
      // 上游原文只进服务端日志，**不进响应体**（2026-10-16 安全审查 P2-3）：
      // 第三方错误原文可能夹带内部信息（请求 id、账号标识、上游调试串），
      // 回传给前端等于把内部细节公开给任意调用者。
      const detail = await r.text().catch(() => '');
      console.error(
        '[ai-insight] 上游模型返回异常 HTTP ' + r.status + ': ' + String(detail).slice(0, 500)
      );
      return {
        ok: false,
        status: 502,
        error: 'AI 服务调用失败（上游返回 ' + r.status + '），请稍后重试。',
      };
    }
    const data = await withTimeout(r.json(), Math.max(500, remaining() - 200), 'read-body');
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!content.trim()) {
      return { ok: false, status: 502, error: 'AI 返回了空内容，请重试。' };
    }
    return {
      ok: true,
      type: type,
      content: content.trim(),
      model: DEEPSEEK_MODEL,
      remaining: typeof quota.remaining === 'number' ? quota.remaining : null,
    };
  } catch (e) {
    const isTimeout =
      e && (e.name === 'AbortError' || /^TIMEOUT:/.test(String((e && e.message) || '')));
    if (isTimeout) return timeoutResult(startedAt);
    return { ok: false, status: 500, error: 'AI 服务异常，请稍后重试。' };
  }
}

module.exports = {
  TYPES: TYPES,
  AI_QUOTA_FREE: 3,
  AI_QUOTA_MEMBER: 10,
  DEEPSEEK_MODEL: DEEPSEEK_MODEL,
  FUNCTION_TIMEOUT_MS: FUNCTION_TIMEOUT_MS,
  PLATFORM_LIMIT_MS: PLATFORM_LIMIT_MS,
  // 入参长度上限：导出供 tools/verify-security.js 断言「校验与发送同一份对象」。
  // 三个值任一被放宽/移除，回归测试都会红。
  MAX_LEN: MAX_LEN,
  MAX_RAW_LEN: MAX_RAW_LEN,
  MAX_TABLE_LEN: MAX_TABLE_LEN,
  consumeQuota: consumeQuota,
  runInsight: runInsight,
  withTimeout: withTimeout,
  /**
   * 仅供测试用：清空熔断器计数。
   * 生产代码不应调用 —— 它的存在只是让「失败路径」与「正常路径」
   * 的单元测试互不干扰（熔断器打开后会短路后续请求）。
   */
  __resetBreaker: function () {
    consecutiveFailures = 0;
    breakerOpenedAt = 0;
  },
};