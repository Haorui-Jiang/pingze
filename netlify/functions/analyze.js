// Netlify Function 版后端（替代 server.js 的 /api/analyze）
// 部署到 Netlify 时，此文件由平台以 Serverless 方式运行，不再有常驻进程。
// 挂载路径：/.netlify/functions/analyze（经 netlify.toml 重定向 /api/* 映射）
// API Key 由 Netlify 站点环境变量注入（DEEPSEEK_API_KEY），前端不再传入密钥。

// Supabase 数据访问层（缓存 / 配额 / 记流水）
// 与本地 server.local.js 共用同一份 lib/supabase-store.js，避免两份逻辑漂移。
// Netlify 打包时（zip-it-and-ship-it）会跟随 require 把该文件一起带上。
const store = require('../../lib/supabase-store');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
// 界面展示名 → API 实际模型 ID（DeepSeek 接口仅接受小写 ID）
const MODEL_ALIAS = {
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4.1-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek-v4-pro',
};
const resolveModel = (n) => MODEL_ALIAS[String(n).trim().toLowerCase()] || n;

const DEEPSEEK_MODEL = resolveModel(process.env.DEEPSEEK_MODEL || 'DeepSeek-V4.1-Flash');

const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const CHAT_ENDPOINT = /\/chat\/completions$/.test(BASE) ? BASE : BASE + '/chat/completions';

// 函数超时（毫秒）：免费版硬上限 10s，Pro 及以上 26s。
// 默认 9s 以保证在免费版被平台强杀前返回结构化错误；
// Pro 用户可在 Netlify 环境变量中设 FUNCTION_TIMEOUT_MS=25000 以充分利用 26s 额度。
const FUNCTION_TIMEOUT_MS = Math.min(
  parseInt(process.env.FUNCTION_TIMEOUT_MS || '9000', 10) || 9000,
  25000
);

const SYS_PROMPT = `你是一位精通《平水韵》与诗词格律的学者。用户会提交一段诗词或对联文本（可能含标点、空格）。
请严格按下面的 JSON 格式返回分析结果，不要输出任何多余文字、不要使用 markdown 代码块、不要加解释：

{
  "chars": [{"char":"字","tone":"平|仄|通|？|—"}],
  "form": "文体名称（如 五言律诗 / 七言绝句 / 词牌名 等）",
  "yunbu": ["韵部说明（如 下平七阳）"],
  "note": "一句简短的格律点评"
}

规则：
- tone 取值：平（平声）、仄（上/去/入声）、通（多音字跨平仄）、？（未定，极罕见）、—（非汉字：标点 / 数字 / 字母，统一用 —）。
- 逐字对应输入文本顺序；标点（，。？！、；：等）占一位，标为 —。
- 不要为空白字符（空格、换行、制表符、全角空格）输出任何条目：它们不占位，chars 中不得出现 char 为空白的元素。
- 文体须依据句数、每句字数、对仗、押韵判定（如 五言律诗、七言绝句、词牌 等）。
- 韵部按《平水韵》给出（如 上平一东、下平七阳），多韵则列多个。
- 只返回纯 JSON，第一字符必须是 { ，最后字符是 } 。`;

function extractJSON(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** poemId 来自前端，可能是伪造的字符串；不是 UUID 就丢弃 */
function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** 列表页要显示统计值，不必每次展开整个 result jsonb */
function summarizeResult(r) {
  const chars = Array.isArray(r && r.chars) ? r.chars : [];
  const count = (t) => chars.filter((c) => c && c.tone === t).length;
  return {
    char_count: chars.length,
    ping: count('平'),
    ze: count('仄'),
    tong: count('通'),
    form: (r && r.form) || null,
  };
}

/** char 为空白（空串 / 空格 / 换行 / 全角空格）的条目属于无效占位 */
function isBlankChar(c) {
  if (!c) return true;
  const ch = c.char;
  if (ch === undefined || ch === null) return true;
  return String(ch).replace(/[\s\u3000]/g, '') === '';
}

/**
 * 归一化模型返回结果：剔除 char 为空白的占位条目。
 * 模型偶尔会把空格/换行也当成一位输出（tone 记作 —），前端逐字网格
 * 会因此渲染出「空字符 + 符」的空格子。
 */
function normalizeResult(r) {
  if (!r || typeof r !== 'object') return r;
  r.chars = Array.isArray(r.chars) ? r.chars.filter((c) => !isBlankChar(c)) : [];
  return r;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST 方法' }) };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求体不是合法 JSON' }) };
  }

  const { text, poemId } = parsed;
  if (!text || !String(text).trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请输入要分析的诗词文本' }) };
  }
  if (!DEEPSEEK_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: '服务端未配置 DEEPSEEK_API_KEY。请在 Netlify → Site settings → Environment variables 中添加该变量后重新部署。',
      }),
    };
  }

  // ---------- Supabase：身份 → 缓存 → 配额 ----------
  const startedAt = Date.now();
  const h = event.headers || {};
  const token = store.extractBearer(h.authorization);
  const user = await store.getUserFromToken(token);
  const clientIp = (h['x-forwarded-for'] || h['client-ip'] || '').split(',')[0].trim();

  // 强制登录：必须在查缓存之前拦，否则匿名也能白嫖缓存结果
  if (store.REQUIRE_LOGIN && !user) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: '请先登录后再使用分析功能。', needLogin: true }),
    };
  }
  const actorKey = store.anonymousActorKey(clientIp, h['user-agent']);
  const inputHash = store.computeInputHash({ text: text, model: DEEPSEEK_MODEL });
  const safePoemId = isUuid(poemId) ? poemId : null;
  let cacheId = null;

  if (store.ENABLED) {
    // 命中缓存：零成本零等待，也不消耗配额
    try {
      const cached = await store.findCached(inputHash);
      if (cached) {
        cacheId = cached.id;
        // 老缓存里可能残留空白占位条目，命中时一并清洗
        normalizeResult(cached.result);
        const latency = Date.now() - startedAt;
        await store.recordAnalysis({
          user_id: user ? user.id : null, poem_id: safePoemId, cache_id: cacheId,
          input_text: text, input_hash: inputHash,
          engine: store.ENGINE, engine_version: store.ENGINE_VERSION, model: DEEPSEEK_MODEL,
          result: cached.result, summary: cached.summary, latency_ms: latency,
        });
        await store.recordUsage({
          user_id: user ? user.id : null, actor_key: actorKey,
          status: 'cache_hit', latency_ms: latency,
        });
        return { statusCode: 200, headers, body: JSON.stringify(cached.result) };
      }
    } catch (e) {
      console.warn('[sb] 缓存查询失败，按常规流程继续:', e && e.message);
    }

    try {
      const q = await store.checkQuota(user, actorKey);
      if (!q.allowed) {
        await store.recordUsage({
          user_id: user ? user.id : null, actor_key: actorKey, status: 'quota_exceeded',
        });
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({
            error: q.tier === 'member'
              ? `今日额度已用尽（${q.used}/${q.quota}）。明天再来吧。`
              : `今日免费额度已用尽（${q.used}/${q.quota}）。开通会员后每日可分析 ${store.QUOTA_BY_TIER.member} 次。`,
            quota: q.quota, used: q.used, remaining: 0,
            tier: q.tier, needUpgrade: q.tier !== 'member',
          }),
        };
      }
    } catch (e) {
      console.warn('[sb] 配额检查失败，放行本次请求:', e && e.message);
    }
  }

  const userContent = `【待分析文本】\n${text}`;

  try {
    // 注意：Netlify 免费版函数硬上限 10s，Pro 及以上 26s。
    // 超时值设在平台限制内，让超时由本函数主动返回结构化错误，而非被平台强杀成空响应。
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
          { role: 'system', content: SYS_PROMPT },
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
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `DeepSeek 调用失败（HTTP ${r.status}）`, detail }),
      };
    }

    const data = await r.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    const clean = extractJSON(content);
    if (!clean) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'DeepSeek 返回内容不是可解析的 JSON', raw: content.slice(0, 500) }),
      };
    }
    // 剔除空白占位条目，避免逐字网格出现空字符格子
    normalizeResult(clean);
    // 结果入缓存 + 记账。写入失败绝不能影响返回结果。
    if (store.ENABLED) {
      const latency = Date.now() - startedAt;
      const usage = data.usage || {};
      const summary = summarizeResult(clean);
      cacheId = await store.saveCache({
        input_hash: inputHash, input_text: text,
        engine: store.ENGINE, engine_version: store.ENGINE_VERSION, model: DEEPSEEK_MODEL,
        result: clean, summary: summary,
      });
      await store.recordAnalysis({
        user_id: user ? user.id : null, poem_id: safePoemId, cache_id: cacheId,
        input_text: text, input_hash: inputHash,
        engine: store.ENGINE, engine_version: store.ENGINE_VERSION, model: DEEPSEEK_MODEL,
        result: clean, summary: summary, latency_ms: latency,
        tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0,
      });
      await store.recordUsage({
        user_id: user ? user.id : null, actor_key: actorKey, status: 'ok',
        tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0,
        latency_ms: latency,
      });
    }
    // 回吐统一用归一化后的 JSON，而不是 DeepSeek 的原始字符串：
    //   1) 原始串可能带 ```json 围栏 / 缩进差异，前端 JSON.parse 会直接失败
    //   2) 缓存命中回的是 JSON.stringify(result)，两条路径必须字节一致
    return { statusCode: 200, headers, body: JSON.stringify(clean) };
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    if (store.ENABLED && isTimeout) {
      // 超时也算消耗掉了：调用已经发出去，钱已经花出去了
      await store.recordUsage({
        user_id: user ? user.id : null, actor_key: actorKey,
        status: 'timeout', latency_ms: Date.now() - startedAt,
      });
    }
    return {
      statusCode: isTimeout ? 504 : 500,
      headers,
      body: JSON.stringify({
        error: isTimeout
          ? `调用 DeepSeek 超时（已等待约 ${Math.round(FUNCTION_TIMEOUT_MS / 1000)} 秒）。免费版函数上限 10s、Pro 上限 26s，长诗易超时。Pro 用户可在环境变量设置 FUNCTION_TIMEOUT_MS=25000；或缩短待分析文本后重试。`
          : '服务端异常',
        detail: String(e),
      }),
    };
  }
};
