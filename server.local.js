// 平仄韵目查询 · 本地服务（Node 20+ 原生 http）
//
// V5 架构（2026-10-16）：
//   · 平仄 / 韵部 / 重字查询 = 浏览器本地查表（结果/pingze-engine.js +
//     pingshui-yun-data.js），不经过本服务、不调用任何大模型。
//   · 本服务只保留四类接口：
//       /api/health          健康检查
//       /api/ai-insight      AI 平仄分析 / 诗词鉴赏（登录 + 配额，见 lib/ai-insight.js）
//       /api/admin-*         后台（管理员白名单，见 lib/admin.js）
//   · 注册不在这里：前端直接用 Supabase 客户端 SDK 的 signUp，
//     由 Supabase 发验证邮件（SMTP 已接 Resend），验证通过后才能登录。
//   · API Key 仅从 .env / 环境变量读取，前端不再传入密钥。

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- .env 加载 ----------
// 必须排在所有本地模块 require 之前：lib/* 在导入那一刻就去读
// SUPABASE_URL / SUPABASE_SERVICE_KEY / DEEPSEEK_API_KEY，
// 晚一步加载的话 ENABLED 恒为 false、密钥恒为空。
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

// Supabase 数据访问层（JWT 换用户等；与 Netlify Function 共用，避免两份漂移）
const store = require('./lib/supabase-store');
const admin = require('./lib/admin');
const insight = require('./lib/ai-insight');

const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// ---------- 静态资源（对应 netlify.toml 的 publish = "结果"）----------
// 前端新增了 supabase-config.js / auth.js / pingze-engine.js 等本地脚本，
// 本地没有静态服务的话会 404。这里把「结果」目录整体挂到根路径，
// 行为与 Netlify 保持一致。
const PUBLIC_DIR = path.join(__dirname, '结果');

// 无扩展名的友好地址 → publish 目录下的静态文件。
// 与 netlify.toml 的 [[redirects]] 必须成对维护（见文件内 STATIC_ROUTES 处说明）。
const STATIC_ROUTES = {
  '/admin': 'admin.html',
  '/pingshui-yun': 'pingshui-yun.html',
};

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
  // SEO 站点根文件：本地不补这两项会以 application/octet-stream 吐出，
  // 线上 Netlify 自己认，但本地验证会失真（浏览器直接下载而不是渲染）。
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
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

/** 取客户端 IP：本地直连没有反代头，Netlify 等平台走 x-forwarded-for */
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

const server = http.createServer((req, res) => {
  // ---------- 静态资源 ----------
  // 注意：必须先确认文件真实存在再返回，否则 /api/health 这类路由会被这里吞成 404
  if (req.method === 'GET' || req.method === 'HEAD') {
    // 无扩展名的友好地址 → publish 目录下的静态文件（与 netlify.toml 的 [[redirects]] 一一对应，
    // 两边必须同时改，否则本地能开、线上 404（或反之）。
    // Pretty URLs 在 Netlify 上是关掉的，所以线上不能靠 /xxx/ 目录式地址，只能走重定向。
    var cleanPath = (req.url || '').split('?')[0].split('#')[0];
    if (STATIC_ROUTES[cleanPath]) {
      sendFile(res, path.join(PUBLIC_DIR, STATIC_ROUTES[cleanPath]), 200);
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
      model: insight.DEEPSEEK_MODEL,
      keyReady: !!DEEPSEEK_API_KEY,
      supabase: store.ENABLED,
      note: '平仄/韵部查询为浏览器本地查表，不经过本服务；AI 赏析需登录并按次计配额',
    }));
    return;
  }

  // ---------- AI 赏析（平仄分析 / 诗词鉴赏，登录 + 配额）----------
  // 查表不经过这里；只有前端勾选了某个 AI 开关才会请求本接口。
  if (req.method === 'POST' && req.url === '/api/ai-insight') {
    readJsonBody(req, res, async (parsed) => {
      // 全函数总预算：本地无平台硬限时，但同一套 deadline 口径保证
      // 「模型再慢也会在预算内返回结构化错误」而不是挂死请求
      const deadline = Date.now() + insight.FUNCTION_TIMEOUT_MS;
      try {
        const token = store.extractBearer(req.headers.authorization);
        const user = await store.getUserFromToken(token);
        const out = await insight.runInsight({
          type: parsed.type,
          text: parsed.text,
          table: parsed.table,
          user: user,
          deadline: deadline,
        });
        res.writeHead(out.status || (out.ok ? 200 : 500), { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'AI 服务异常', detail: String(e) }));
      }
    });
    return;
  }

  // ---------- 注册：已退役（2026-10-16）----------
  // 注册改由前端直接调 Supabase 的 signUp（客户端 SDK 用 anon key 即可），
  // 由 Supabase 发验证邮件、验证通过后才拿得到 session。
  // 原先这里的 /api/register 用 service_role 直接建号并写 email_confirm=true，
  // 等于**跳过邮箱验证**，且该免验证入口在公网可被批量调用刷号薅 AI 额度，故移除。
  if (req.url === '/api/register') {
    res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '注册接口已下线，请在前端完成注册。' }));
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
  console.log(`平仄韵目查询站已启动 → http://localhost:${PORT}`);
  console.log('平仄/韵部/重字查询：浏览器本地查表（零服务端成本）');
  console.log(`AI 赏析模型：${insight.DEEPSEEK_MODEL}（需登录，按次计配额）`);
  console.log(DEEPSEEK_API_KEY
    ? 'AI 密钥：已从 .env / 环境变量加载 ✓'
    : '提示：未检测到 DEEPSEEK_API_KEY，AI 赏析不可用；查表功能不受影响');
});
