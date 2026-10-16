# 平仄格律查询站

[![Node](https://img.shields.io/badge/Node-20%2B-339933)](https://nodejs.org)
[![Engine](https://img.shields.io/badge/Engine-Local%20Dictionary-8b5a2b)](./结果/pingze-engine.js)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek--Chat-4d6bfe)](https://www.deepseek.com)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e)](https://supabase.com)
[![Netlify](https://img.shields.io/badge/Deploy-Netlify-00c7b7)](https://www.netlify.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[中文](./README.md)　　[English](./README.en.md)

> 输入一首诗词，**逐字标注平仄**、给出每句尾字的《平水韵》韵部。
> 平仄判定走**浏览器本地字典查表**（平水韵 106 韵、七千余字），毫秒级返回、断网可用、不调用大模型；
> AI（DeepSeek）只做**可选的**「平仄分析 / 诗词鉴赏」，双开关默认关闭，登录后按次计配额。
> 参考网站：`http://www.zhgc.com/pz/pz.asp`

**在线体验**：<https://www.pingze.site/>

---

## ✨ 功能特性

### 一、平仄查询（核心，纯本地）

- **逐字平仄标注**：平 / 仄 / 通（多音字平仄两读）/ ？（未定）/ 未收录（全角空格占位），逐字符与原诗对齐，位置不塌。
- **句尾韵部**：每个分句行尾标注「◆ 尾字【韵部】」，按「上平 → 下平 → 上声 → 去声 → 入声」排序；末字无韵目时自动回退一位取前字；多音字全列韵部。
- **统计摘要**：总字数、平声数、仄声数实时计算。
- **古平仄推导**：由「字 → 韵部」反查表推导——只入平声韵为平，只入上/去/入声韵为仄，平仄韵都入为通。
- **输入规范**：上限 1000 字；自动清除半角/全角空格与制表符；按标点符号表分句（连续标点合并、首尾标点不产空句）；未收录字不跳过、原位占位。
- **一键复制**：完整结果（原文 + 平仄串 + 尾字韵部 + 统计）整段复制到剪贴板。
- **零服务端成本**：判定全在浏览器完成，不请求后端、不耗配额、断网可用；查询**永久免费、无需登录**。

### 二、AI 赏析（可选，双开关）

- **两个独立开关**：「AI 平仄分析」与「诗词鉴赏」，**默认全关**；勾选后才出现生成按钮，未勾选时零请求（浏览器网络面板可验证）。
- **AI 平仄分析**：以本地查表结果（平仄串、尾字韵部）为确定输入，判粘对、孤平、三平尾、拗救、对仗、押韵归类——提示词明确要求「以传入查表结果为准，不得自行改判」。
- **诗词鉴赏**：意境、章法、修辞、典故。
- **服务端防绕过**：开关与配额都在服务端二次校验，不信前端；先原子扣减配额再调模型，配额故障时降级放行。
- **失败隔离**：AI 失败只影响当次赏析，上方查表结果不受任何影响。
- **按次计配额**：免费 3 次/天、会员 10 次/天，按北京时间自然日重置（`ai_usage_today()` / `ai_quota_consume()` 两个 RPC，后者 security definer 原子扣减）。

### 三、账号与数据

- **邮箱密码注册 / 登录**：基于 Supabase Auth，会话自动刷新。
- **查询记录**：登录用户可保存每次查询（「☆ 保存本次查询」），在记录面板中回放与删除；面板可折叠，按钮文案随开关状态切换；RLS 保证只能读 / 建 / 删自己的记录。
- **保存即见**：点保存后面板自动打开并刷新；原本已打开则只刷新不滚动；未登录时三处提示「登录后可保存」。

### 四、会员与运营

- **每日配额**：免费 3 次/天、会员 10 次/天（AI 赏析专用；查表不计数）。
- **付费引导**：AI 额度用尽时弹出二维码引导开通会员（30 天 ¥30）；配额判定以服务端 RPC 为准，刷新页面无法绕过。
- **管理后台 `/admin`**：邮箱白名单鉴权（`ADMIN_EMAILS`，服务端用 service_role 重新校验 JWT，前端仅作体验层），可浏览用户列表、查询记录数、今日 AI 用量、注册/最近登录时间（东八区），以及开通 / 降级会员与到期倒计时。
- **会员有效期**：`tier=member` 且 `member_expires_at > now()` 才算有效；到期不自动降级，仅失活，由运营人决定续费或降级，便于对账。
- **注册风控**：单 IP 每小时上限 + 全站每小时上限；计数异常时宁放行不误挡。

### 五、工程特性

- **零依赖、零构建**：前端原生 HTML / CSS / JS，后端只用 Node 内置模块，无 `node_modules`。
- **本地与线上同一份逻辑**：`lib/` 下的共享库同时被本地后端与 Netlify 函数引用，避免两份实现漂移。
- **严格数据隔离**：数据库启用 RLS + 列级权限；用户无法把自己改成 `member` 或篡改配额计数。
- **东八区时间口径**：数据库默认时区为 `Asia/Shanghai`，所有时间戳（注册时间、到期时间等）渲染为东八区；存储仍是 UTC 绝对时间。
- **SEO 就绪**：两个公开页（`/` 与 `/pingshui-yun`）配置了 title / description / keywords / OG 与百度统计；`tools/gen-sitemap.js` 自动生成 sitemap。

---

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JS（零依赖；宣纸底 + 楷体 + 印泥红古风） |
| 查表引擎 | `结果/pingze-engine.js`（UMD，Node 可 require，42 条断言回归） |
| 本地后端 | Node.js 20+ 原生 `http` + `fetch`（`server.local.js`） |
| 线上后端 | Netlify Serverless Functions（`netlify/functions/`） |
| 数据库 / 认证 | Supabase（Postgres + Auth + RLS） |
| 大模型 | DeepSeek-Chat（接口 ID `deepseek-chat`，仅 AI 赏析用） |

> **模型 ID 说明**：DeepSeek 接口只接受小写 ID（`deepseek-chat` / `deepseek-flash` / `deepseek-v4-pro`），
> 不接受展示名。代码里用 `MODEL_ALIAS` 做映射，`DEEPSEEK_MODEL` 填展示名或 ID 均可。
> **默认 `deepseek-chat`（非推理型，约 2-4s 返回）**：`deepseek-flash`（V4.1-Flash）是推理型模型，
> 每次先输出 2000-4000 个 reasoning tokens 才给正文，单次 14-26s，会越过 Netlify 函数时限
> 被网关杀成 504 空响应（2026-10-16 线上事故），**勿在 Serverless 环境使用**。

---

## 📁 目录结构

```
pingze/
├── 结果/                      # 静态站点发布目录（netlify.toml 里 publish = "结果"）
│   ├── index.html             # 首页：查表界面 + 登录/注册弹层 + 查询记录面板 + AI 双开关 + 付费二维码弹层
│   │                          #   　<head> 内含百度站点验证 meta（见「站点验证」小节）
│   ├── pingshui-yun.html      # 平水韵 106 韵韵部对照表（SEO 承载页）
│   ├── pingshui-yun-data.js   # 韵表数据（window.PINGSHUI_YUN）
│   ├── pingze-engine.js       # 本地查表引擎：平仄 / 尾字韵部 / 重字（V5 核心，UMD）
│   ├── auth.js                # 前端认证与数据层：登录、查询记录、配额
│   ├── admin.html  admin.js   # 管理后台（邮箱白名单鉴权）
│   ├── supabase-config.example.js  # 前端配置模板（复制为 supabase-config.js 后填真实值）
│   ├── baidu_verify_codeva-W1T8O1gd3p.html  # 百度站长平台站点归属验证文件，**文件名与内容不可改动**
│   └── 二维码.jpg             # 会员付费引导二维码
├── lib/                       # 本地后端与 Serverless 函数共用的服务端逻辑
│   ├── supabase-store.js      # Supabase REST 访问层、JWT 换用户
│   ├── auth.js                # 用户身份识别、注册限流
│   ├── admin.js               # 管理员鉴权 + 用户列表 + 改会员等级
│   └── ai-insight.js          # AI 赏析：登录校验、原子配额、DeepSeek 调用（V5 新增）
├── netlify/functions/         # 线上后端（与本地后端行为一致）
│   ├── ai-insight.js          # POST /api/ai-insight（type: analysis | appreciation）
│   ├── register.js            # POST /api/register
│   ├── admin-users.js         # GET  /api/admin-users
│   └── admin-set-tier.js      # POST /api/admin-set-tier
├── supabase/migrations/       # 数据库迁移脚本（按文件名顺序执行）
├── scripts/
│   └── gen-supabase-config.js # 构建期生成 结果/supabase-config.js（从环境变量取值，见「部署到 Netlify」）
├── netlify.toml               # 发布目录、函数目录、构建命令、函数超时、路由重写
├── package.json
├── server.local.js            # 本地开发后端（含静态服务，行为对齐 Netlify）
├── .env.example               # 服务端环境变量模板
└── LICENSE
```

> V5 起已删除旧的 `netlify/functions/analyze.js`（AI 逐字判平仄）——平仄判定改为纯前端查表，`/api/analyze` 路由随之废弃。

---

## 🚀 本地运行

前置：**Node.js 20+**（用到内置 `fetch`，以及 `process.loadEnvFile`）。项目零 npm 依赖，无需 `npm install`。

```bash
# 1. 准备服务端环境变量
cp .env.example .env      # 至少填 DEEPSEEK_API_KEY（只影响 AI 赏析；查表不需要它）

# 2. 准备前端配置（浏览器读不到 .env，需单独一份）
cp 结果/supabase-config.example.js 结果/supabase-config.js
#    填入 Supabase 的 Project URL 与 anon public key
#    （线上这份文件由构建脚本自动生成，本地才需要手动建）

# 3. 启动
npm start                 # 等价于 node server.local.js
npm run dev               # 等价于 node --watch server.local.js（改代码自动重启）
```

打开 <http://localhost:3000>，管理后台在 <http://localhost:3000/admin>。

**健康检查**（仅本地后端提供，Netlify 上没有这个路由）：

```bash
curl http://localhost:3000/api/health
# {"ok":true,"model":"deepseek-chat","keyReady":true,"supabase":true,"note":"平仄/韵部查询为浏览器本地查表，不经过本服务；AI 赏析需登录并按次计配额"}
```

`keyReady` / `supabase` 可快速判断 `.env` 是否生效。端口被占用时用 `PORT=3001 npm start`。

> 修改**后端**（`server.local.js` / `lib/`）后需重启服务；
> 修改 `结果/` 下的静态文件**不需重启**，刷新浏览器即可（响应带 `Cache-Control: no-cache`）。

---

## 🗄 数据库初始化

1. 在 Supabase 建好项目，取 **Project URL**、**anon public key**（给前端）、**service_role key**（只给服务端）。
2. 打开 **SQL Editor**（或本项目工作区的 `python db/sb.py sqlfile <脚本>`），按文件名顺序逐个执行 `supabase/migrations/` 下的脚本：

| 脚本 | 作用 |
|---|---|
| `0000_bootstrap_exec_sql.sql` | 创建 `service_role` 专属的 `exec_sql` RPC（后续迁移与后台 SQL 都靠它）。**必须最先执行** |
| `0001_p0_strict.sql` | 初版核心表 + RLS 严格隔离（profiles / poems / analyses / analysis_cache / api_usage / feedback；后五张已由 `0007` 删除） |
| `0002_fix_column_privileges.sql` | 修正列级权限（先收整表再按列放行），挡住用户自我提权 |
| `0003_fix_quota_counting.sql` | 配额口径修正：只统计 `ok` / `timeout`，缓存命中与超限重试不计费 |
| `0004_set_daily_quota_10.sql` | 默认每日配额调整为 10 |
| `0005_simplify_profiles.sql` | 精简 `profiles` 为 `(id, email, created_at)` |
| `0006_membership.sql` | 会员体系：`tier` / `member_since` / `member_expires_at` + 有效会员判定 + 防提权触发器 |
| `0007_v5_query_engine.sql` | **V5 主迁移**：删除 poems / analyses / analysis_cache / api_usage / feedback 五张表；新建 `queries` 查询记录表（RLS 本人可读/建/删，anon 全 revoke）；profiles 增加 `ai_used_date` / `ai_used_count` 轻量计数列；创建 `ai_usage_today()` / `ai_quota_consume(uuid)` 两个 RPC |
| `20261016000347_set_timezone_cst.sql` | 数据库默认时区改为 `Asia/Shanghai`（时间戳渲染东八区，存储不变） |

3. 建表后如 REST 接口看不到新表，执行一次 `NOTIFY pgrst, 'reload schema';` 刷新 PostgREST 的 schema 缓存。

> **顺序不能乱**：`0000` 依赖 `service_role`；`0002` 必须在 `0001` 之后；`0006` 必须在 `0004` 之后；`0007` 依赖前面各表已存在（它负责删除）。

---

## ☁️ 部署到 Netlify

本仓库是**干净的可发布形态**，`netlify.toml` 已声明发布目录与函数目录：

```bash
netlify deploy --prod
```

### 唯一的构建步骤：生成前端 Supabase 配置

`结果/supabase-config.js` 含真实 Project URL 与 anon key，**被 `.gitignore` 排除、不进仓库**，
所以线上必须现场生成，否则该文件 404，前端降级为「账号功能未启用」。`netlify.toml` 因此声明：

```toml
command = "node scripts/gen-supabase-config.js"
```

该脚本在构建时从环境变量 `SUPABASE_URL` + `SUPABASE_ANON_KEY` 生成该文件，并做三项校验：

1. 两个变量都必须存在；
2. key 必须是合法 JWT，且 `role` 必须是 **`anon`** —— 误填 `service_role` 会**直接中断构建**，
   防止把全库权限泄露到浏览器；
3. URL 的 project ref 与 key 的 ref 必须一致。

任一校验失败都会 `exit 1`，**让构建失败而不是静默产出空配置**。改完环境变量后需要重新部署才会生效。

需要在该站点的 **Site settings → Environment variables** 中配置下列变量：

| 变量 | 说明 | 必填 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（仅 AI 赏析使用；查表不依赖它） | ✅ |
| `SUPABASE_URL` | 项目根地址，**不要带 `/rest/v1`** | ✅ |
| `SUPABASE_SERVICE_KEY` | service_role key，**只放服务端** | ✅ |
| `SUPABASE_ANON_KEY` | anon public key，**构建时注入前端**（不是函数运行时用的） | ✅ |
| `ADMIN_EMAILS` | 管理后台邮箱白名单，逗号分隔。未配置时**任何人都进不去**（fail-closed） | ✅ |
| `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | 默认 `deepseek-chat` / `https://api.deepseek.com` | 可选 |
| `FUNCTION_TIMEOUT_MS` | AI 赏析的**全函数总预算**（毫秒），默认 `8000`。冷启动、Supabase 往返、模型调用、序列化都从这算；实际生效值 = `min(FUNCTION_TIMEOUT_MS, PLATFORM_LIMIT_MS - 500)` | 可选 |
| `PLATFORM_LIMIT_MS` | 部署平台对同步函数的硬限时，默认 `10000`（Netlify 免费版 10s；Pro 可到 `26000`，同时调大 `FUNCTION_TIMEOUT_MS`） | 可选 |
| `SUPABASE_TIMEOUT_MS` | Supabase 单次请求超时，默认 `5000`（防止卡住吃掉 AI 接口的整个预算） | 可选 |
| `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR` | 注册风控上限 | 可选 |
| `NODE_VERSION` | 建议 `20` | 建议 |

> `SUPABASE_ANON_KEY` 的作用域必须包含 **builds**，否则构建期读不到。

**路由**：`netlify.toml` 把 `/api/*` 重写到 `/.netlify/functions/:splat`，`/admin` 重写到 `/admin.html`。

> **函数超时**：Netlify 免费版硬上限 10 秒。V5 起平仄查询不经过服务端（浏览器本地毫秒级返回），
> 超时只可能影响 AI 赏析单次生成，且失败不影响已展示的查表结果。
> AI 接口的超时是「全函数总预算」：调用方在函数入口传入 deadline（冷调用把容器启动时间也计入），
> 任何阶段超时都在平台杀进程之前返回结构化 JSON 错误（`{"ok":false,"status":504,...}`），
> 前端显示人话提示，不会再出现 504 空响应配「AI 没有返回内容」的困惑组合。

### 🔎 百度站点验证（两种方式并存，互为备用）

归属校验在仓库里放了两处，任一生效即可通过；**两处必须是同一套码**，换码就要同步换两处：

| 方式 | 位置 | 要点 |
|---|---|---|
| 验证文件 | `结果/baidu_verify_codeva-W1T8O1gd3p.html` | 32 字节、内容 `b5da3bce8d976003fb0cec7f8984b6bc`、**无结尾换行**；文件名与内容一字不能改 |
| meta 标签 | `结果/index.html` 的 `<head>` 内 | `<meta name="baidu-site-verification" content="codeva-W1T8O1gd3p" />` |

自检：`node tools/check-domain.js` 的【3/5】段会断言「验证文件首次请求即 200 且内容一致」、
「首页 `<head>` 内含该 meta」，以及**反向断言「`<head>` 内不得再有历史验证码」**。

> **换验证文件的操作顺序**（换码时最容易出错的一步）：
> 1. 把新文件放进 `结果/`，并从 `结果/` 删掉旧文件；
> 2. 同步更新 `tools/sync-pingze.js` 的 `FILES` 白名单 —— **把旧那一行删掉**，
>    否则脚本会因「源文件缺失」报错并以 exit 1 结束；
> 3. 跑 `node tools/sync-pingze.js`：它会自动把仓库里的旧验证文件当**孤儿文件**删除
>    （见脚本「2.5 清理白名单外的孤儿文件」段），不需要手工 `git rm`；
> 4. 更新 `结果/index.html` 的 meta 与本文档上表，再提交推送。

### ℹ️ 验证文件返回 304 是正常的，不是故障

用浏览器「检查网络」看这个文件时，**常会看到 `304 Not Modified` —— 这是正常的，不需要修**。

服务器给静态文件发的是 `Cache-Control: public,max-age=0,must-revalidate` + `ETag`（Netlify 默认行为）。
浏览器**复访**时会自动带上 `If-None-Match: <上次拿到的 ETag>`，Netlify 比对后确认内容没变，
于是回 **304 + 空响应体**，让浏览器直接用本地缓存。这对校验没有任何影响：

| 请求形态 | 期望状态码 | 说明 |
|---|---|---|
| 全新访客（无任何条件头） | **200** + 完整体 | 搜索引擎首次抓取就是这种 |
| 爬虫 UA（Baiduspider 等） | **200** | 同上 |
| 带过期/伪造 `If-None-Match` | **200** | 证明服务器真的在比对内容 |
| 带正确 `If-None-Match`（复访） | **304** | 内容未变，省流量；**不是错误** |

**关键区分**：304 是「资源未变」，301/302 是「资源搬家」——**只有后者会让站点校验失败**。
所以只要**首次访问（`curl` 不带条件头）拿到 200 且无 `Location`**，就是健康的。

自检命令（看首次响应，不跟随重定向，不要带缓存头）：

```bash
curl -sS -o /dev/null -w "%{http_code} redirect=[%{redirect_url}]\n" \
  "https://www.pingze.site/baidu_verify_codeva-W1T8O1gd3p.html"
# 期望：200 redirect=[]
```

`node tools/check-domain.js` 的【3/5】段会自动跑这组矩阵（全新访客 / 伪造 ETag / 爬虫 UA 三者必须 200，
正确 ETag 复访得 304 属预期），并在结论里显式说明「304 属预期，非错误」，避免把正常缓存协商误判成故障。

> ⚠️ 仓库里**同时**保留多份历史验证文件并无好处：旧的码一旦失效就只是死文件，
> 且站点根目录多一份可被扫到的文件。只保留当前生效的那一份。

### ⚠️ 站点设置必须关闭 Pretty URLs

本站的 **Site settings → Build & deploy → Post processing → Pretty URLs 必须保持关闭**
（API 里的 `processing_settings.html.pretty_urls = false`）。

开启时 Netlify 会为每个 `.html` 生成 301：把 `/foo.html` 重定向到**小写且去掉扩展名**的
`/foo`。这对站点验证文件是致命的——`结果/baidu_verify_codeva-W1T8O1gd3p.html` 会先被 301 到
`/baidu_verify_codeva-w1t8o1gd3p`，百度/Google 的校验就会失败（它们要求目标 URL 首次请求即返回 200）。

判据与自检（不跟随重定向，看首次响应的状态码）：

```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  "https://www.pingze.site/baidu_verify_codeva-W1T8O1gd3p.html"
# 期望：200 且 redirect_url 为空
```

> 该设置是**站点级**的，不能写进 `netlify.toml`，因此改动它之后**必须重新部署**才会生效
> （301 规则是部署处理阶段固化进 CDN 的）；本仓库里看不出来，只能通过 API 或控制台确认。

### ⚠️ 不要启用 GitHub Pages

本仓库**唯一**的部署入口是 Netlify（<https://www.pingze.site>）。**GitHub Pages 必须保持关闭**
（Settings → Pages → Source 选 `None`；API 上 `GET /repos/{owner}/{repo}/pages` 应返回 404）。

两个理由：

1. 仓库根目录**不是**站点根——站点在 `结果/`，由 `netlify.toml` 的 `publish` 指定。启用 Pages
   只会把仓库源文件当静态站发布，得到 `https://haorui-jiang.github.io/pingze/` 这样的 **404 死链**。
2. 更实际的影响：Pages 开启时**每次 push 都会生成一条 `github-pages` deployment 记录**
   （并自动创建同名 environment），把仓库的 Deployments 页刷满无用条目。

关闭方式（一次性）：

```bash
REPO=repos/Haorui-Jiang/pingze
gh api --method DELETE $REPO/pages                     # 关闭 Pages（204）
gh api --method DELETE $REPO/environments/github-pages  # 清掉遗留的环境壳（204）
```

> 清理历史 deployment 记录时，删除**处于活动状态**的会返回 **422**
> （`We cannot delete an active deployment unless it is the only deployment in a given environment.`），
> 需先 `POST /repos/{owner}/{repo}/deployments/{id}/statuses` 补一条 `state=inactive` 再删。

---

## 🔐 密钥与安全

**绝不入库**（已在 `.gitignore` 中排除）：

- `.env` / `.env.local` —— 含 `DEEPSEEK_API_KEY` 与 `SUPABASE_SERVICE_KEY`
- `结果/supabase-config.js` —— 含真实的 Supabase URL 与 anon key（仓库里只放 `.example.js` 模板；
  线上由 `scripts/gen-supabase-config.js` 在构建时从环境变量现场生成，见「部署到 Netlify」）

**anon key 与 service_role key 的区别**（最容易搞错的地方）：

| Key | 位置 | 安全性 |
|---|---|---|
| `anon` public key | 前端 `结果/supabase-config.js`，浏览器可见 | 设计上就是公开的，真正保护数据的是 RLS 策略 |
| `service_role` key | 仅服务端环境变量 | **绕过一切权限**。一旦进了前端等于把全库开放给所有人 |

**数据库侧防护**：RLS 只管「行」不管「列」，因此额外叠加了
① 先 `revoke update on <table>` 收整表、再 `grant update (安全列)` 按列放行；
② BEFORE UPDATE 守卫触发器还原受保护列。两者都在迁移脚本里。
AI 配额的扣减只走 security definer 的 `ai_quota_consume(uuid)` RPC，前端无法直接写计数列。

---

## ⚠️ 已知限制

- **注册不校验邮箱真实性**：为绕开 Supabase 默认 SMTP 的严格限流，注册走服务端
  `/api/register` 用 `service_role` 直接建「已确认」账号，因此任何人可用假邮箱注册，
  靠 `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR` 防刷。
  接入自定义 SMTP（需自有域名配 SPF/DKIM/DMARC）后，应恢复邮箱确认并把注册改回 `client.auth.signUp`。
- **查表引擎刻意不做**文体判定、格律校验、马蹄韵与上下文消歧——与 V4.2 口径一致；
  这些分析交给可选的 AI 赏析，且仅作提示。
- **韵表未收录的字**（后起字 / 异体字）以「？」占位，位置不塌；重字不做繁简归一（云 ≠ 雲）。
- **AI 赏析默认用非推理模型**（`deepseek-chat`）：推理型模型（`deepseek-flash`）单次要 14-26s，
  在 Serverless 时限内必被网关杀成 504；若改用推理模型，需同时调大 `FUNCTION_TIMEOUT_MS`
  与 `PLATFORM_LIMIT_MS`（Pro 26s 额度），且仍可能超时——超时按次扣配额，防止重试循环烧钱。
- **本仓库只收录程序本体**：批量清库、冒烟测试等运维脚本属于开发过程产物，未纳入。

---

## 📜 许可证

MIT — 可自由用于学习与二次开发，详见 [LICENSE](./LICENSE)。
