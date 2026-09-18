// 平仄格律查询 · 服务端代理（Node 22 原生 http + fetch → DeepSeek）
// 对标 www.zhgc.com/pz/pz.asp，但用大模型实时分析替代逐字字典查表。
// API Key 仅从 .env / 环境变量读取，前端不再传入密钥。

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- .env 加载 ----------
// 必须排在所有本地模块 require 之前：lib/supabase-store.js 在导入那一刻
// 就去读 SUPABASE_URL / SUPABASE_SERVICE_KEY，晚一步加载的话 ENABLED 恒为 false。
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file); // Node 20.12+ / 21.7+ 内置
      return;
    } catch {
      /* 回退到手写解析 */
    }
  }
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

// Supabase 数据访问层（缓存 / 配额 / 记流水）
// 与 Netlify Function 版共用同一份 lib/supabase-store.js，避免两份逻辑漂移
const store = require('./lib/supabase-store');
const authReg = require('./lib/auth');
const admin = require('./lib/admin');

const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// ---------- 静态资源（对应 netlify.toml 的 publish = "结果"）----------
// 前端新增了 supabase-config.js / auth.js 两个本地脚本，本地没有静态服务的话会 404。
// 这里把「结果」目录整体挂到根路径，行为与 Netlify 保持一致。
const PUBLIC_DIR = path.join(__dirname, '结果');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

/** 解析请求路径为磁盘路径；越界或非法一律返回 null */
function resolveStatic(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null; // URL 里有非法百分号编码
  }
  if (p === '/' || p === '') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const abs = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(p));
  // 防目录穿越：必须仍在 PUBLIC_DIR 之内
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

function sendFile(res, file, status) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(status || 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 500 ? '读取文件失败' : 'Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}
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
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '55000', 10) || 55000;

const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const CHAT_ENDPOINT = /\/chat\/completions$/.test(BASE) ? BASE : BASE + '/chat/completions';

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
  // 去掉可能的 ```json 或 ``` 包裹
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** 取客户端 IP：本地直连没有反代头，Netlify / Railway 走 x-forwarded-for */
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function readJsonBody(req, res, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    // 防止有人把几百 MB 的垃圾塞进来
    if (body.length > 64 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请求体过大' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
      return;
    }
    cb(parsed);
  });
}

/** poemId 来自前端，可能是伪造的字符串；不是 UUID 就丢弃，别让外键写入报错 */
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
 * 会因此渲染出「空字符 + 符」的空格子。在入口处堵住，保证缓存、
 * analyses 表、回吐三条路径都干净。
 */
function normalizeResult(r) {
  if (!r || typeof r !== 'object') return r;
  r.chars = Array.isArray(r.chars) ? r.chars.filter((c) => !isBlankChar(c)) : [];
  return r;
}

const server = http.createServer((req, res) => {
  // ---------- 静态资源 ----------
  // 注意：必须先确认文件真实存在再返回，否则 /api/health 这类路由会被这里吞成 404
  if (req.method === 'GET' || req.method === 'HEAD') {
    // 后台管理页：/admin 直接映射到 结果/admin.html
    var adminPath = (req.url || '').split('?')[0].split('#')[0];
    if (adminPath === '/admin') {
      sendFile(res, path.join(PUBLIC_DIR, 'admin.html'), 200);
      return;
    }

    const file = resolveStatic(req.url || '/');
    if (file) {
      let st = null;
      try {
        st = fs.statSync(file);
      } catch {
        st = null;
      }
      if (st && st.isFile()) {
        sendFile(res, file);
        return;
      }
    }
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      model: DEEPSEEK_MODEL,
      keyReady: !!DEEPSEEK_API_KEY,
      supabase: store.ENABLED,
      engineVersion: store.ENABLED ? store.ENGINE + '/' + store.ENGINE_VERSION : null,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
        return;
      }
      const { text, poemId } = parsed;
      if (!text || !String(text).trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请输入要分析的诗词文本' }));
        return;
      }

      if (!DEEPSEEK_API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务端未配置 DEEPSEEK_API_KEY，请在项目根目录 .env 中填写后重启服务。' }));
        return;
      }

      // ---------- Supabase：身份 → 缓存 → 配额 ----------
      const startedAt = Date.now();
      const token = store.extractBearer(req.headers.authorization);
      const user = await store.getUserFromToken(token);

      // 强制登录：必须在查缓存之前拦，否则匿名也能白嫖缓存结果
      if (store.REQUIRE_LOGIN && !user) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: '请先登录后再使用分析功能。',
          needLogin: true,
        }));
        return;
      }
      const actorKey = store.anonymousActorKey(req.socket.remoteAddress, req.headers['user-agent']);
      const inputHash = store.computeInputHash({ text: text, model: DEEPSEEK_MODEL });
      const safePoemId = isUuid(poemId) ? poemId : null;
      let cacheId = null;

      if (store.ENABLED) {
        // 命中缓存：零成本零等待，也不该消耗配额
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
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(cached.result));
            return;
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
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              error: q.tier === 'member'
                ? `今日额度已用尽（${q.used}/${q.quota}）。明天再来吧。`
                : `今日免费额度已用尽（${q.used}/${q.quota}）。开通会员后每日可分析 ${store.QUOTA_BY_TIER.member} 次。`,
              quota: q.quota, used: q.used, remaining: 0,
              tier: q.tier, needUpgrade: q.tier !== 'member',
            }));
            return;
          }
        } catch (e) {
          console.warn('[sb] 配额检查失败，放行本次请求:', e && e.message);
        }
      }

      const userContent = `【待分析文本】\n${text}`;

      let controller;
      try {
        controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `DeepSeek 调用失败（HTTP ${r.status}）`, detail }));
          return;
        }

        const data = await r.json();
        const content = data.choices?.[0]?.message?.content ?? '';
        const clean = extractJSON(content);
        if (!clean) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'DeepSeek 返回内容不是可解析的 JSON', raw: content.slice(0, 500) }));
          return;
        }
        // 剔除空白占位条目，避免逐字网格出现空字符格子
        normalizeResult(clean);
        // 结果入缓存 + 记账。这些写入失败绝不能影响返回结果。
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(clean));
      } catch (e) {
        const isTimeout = e && e.name === 'AbortError';
        if (store.ENABLED && isTimeout) {
          // 超时也算消耗掉了：调用已经发出去，钱已经花出去了
          await store.recordUsage({
            user_id: user ? user.id : null, actor_key: actorKey,
            status: 'timeout', latency_ms: Date.now() - startedAt,
          });
        }
        res.writeHead(isTimeout ? 504 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: isTimeout
            ? `调用 DeepSeek 超时（已等待 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒）。请稍后重试或缩短待分析文本。`
            : '服务端异常',
          detail: String(e),
        }));
      }
    });
    return;
  }

  // ---------- 注册 ----------
  // 走自己的接口而不是 Supabase 自带 signUp：绕开「每注册发一封确认邮件」
  // 带来的 2 封/小时限流。详见 lib/auth.js 顶部说明。
  if (req.method === 'POST' && req.url === '/api/register') {
    readJsonBody(req, res, async (parsed) => {
      try {
        const out = await authReg.register(parsed.email, parsed.password, clientIp(req));
        res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out.body));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '注册服务异常', detail: String(e) }));
      }
    });
    return;
  }

  // ---------- 后台：用户数据浏览（仅限 ADMIN_EMAILS 白名单账号）----------
  if (req.method === 'GET' && req.url === '/api/admin-users') {
    (async () => {
      const token = store.extractBearer(req.headers.authorization);
      const v = await admin.verifyAdmin(token);
      if (!v.ok) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '无权限：仅限项目管理员账号', reason: v.reason }));
        return;
      }
      try {
        const users = await admin.listUsers();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ count: users.length, users: users }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '读取用户数据失败', detail: String(e && e.message || e) }));
      }
    })();
    return;
  }

  // ---------- 后台：修改用户会员等级（运营人手工开通 / 降级）----------
  if (req.method === 'POST' && req.url === '/api/admin-set-tier') {
    readJsonBody(req, res, async (parsed) => {
      const token = store.extractBearer(req.headers.authorization);
      const v = await admin.verifyAdmin(token);
      if (!v.ok) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '无权限：仅限项目管理员账号', reason: v.reason }));
        return;
      }
      try {
        const out = await admin.setTier(parsed.userId, parsed.tier, parsed.days);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, user: out, operator: v.email }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`平仄格律查询站已启动 → http://localhost:${PORT}`);
  console.log(`模型：${DEEPSEEK_MODEL}　接口：${CHAT_ENDPOINT}`);
  console.log(DEEPSEEK_API_KEY
    ? '密钥：已从 .env / 环境变量加载 ✓'
    : '警告：未检测到 DEEPSEEK_API_KEY，请在项目根目录 .env 中填写后重启服务。');
});
