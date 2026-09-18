# 平仄格律查询站 · DeepSeek

[![Node](https://img.shields.io/badge/Node-20%2B-339933)](https://nodejs.org)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek--V4.1--Flash-4d6bfe)](https://www.deepseek.com)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e)](https://supabase.com)
[![Netlify](https://img.shields.io/badge/Deploy-Netlify-00c7b7)](https://www.netlify.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[中文](./README.md)　　[English](./README.en.md)

> 输入一首诗词，逐字标注平仄、判定文体、溯源《平水韵》韵部。
> 用 **DeepSeek 大模型实时推断**替代传统逐字字典查表，能处理字典收不到的多音字与变格。
> 参考网站：`http://www.zhgc.com/pz/pz.asp`

**在线体验**：<https://pingze-rhyme.netlify.app>

---

## ✨ 功能特性

### 一、格律分析（核心）

- **逐字平仄标注**：平（绿）/ 仄（红）/ 通（灰）/ ？（未定）/ —（标点等非汉字），逐字符对齐原诗。
- **文体自动判定**：依据句数、每句字数、对仗与押韵，给出五言律诗 / 七言绝句 / 词牌等。
- **《平水韵》韵部溯源**：按平水韵给出韵部，如「上平一东」「下平七阳」，多韵并列。
- **格律点评**：每个结果附一句简短的格律说明。
- **一键复制**：完整结果整段复制到剪贴板。
- **进度可见**：分析等待期间前端轮播提示，不白屏。
- **输入清洗**：提交前自动去除换行、半角/全角空格与制表符。
- **字数实时提示**：超过 40 字转红色警示，提示分批提交（避免长文本超时）。
- **健壮性防护**：后端返回不完整或非 JSON 时降级为明确报错，不再出现「文体 —／总字数 0」的假成功。

### 二、账号与数据

- **邮箱密码注册 / 登录**：基于 Supabase Auth，会话自动刷新。
- **必须登录才能分析**：服务端在**查缓存之前**拦截匿名请求（返回 `401 needLogin`），防止匿名白嫖已缓存结果。
- **我的分析**：个人分析历史流水，面板常驻、新分析完成即时刷新。
- **我的作品**：保存 / 编辑 / 删除自己的诗词作品；点击作品正文可回填到输入框重新分析。
- **☆ 保存为作品**：分析完成后一键入库，带防重复与加载态，成功提示常驻。
- **结果缓存**：以 `(输入文本 + 模型 + 引擎版本)` 哈希去重；**命中缓存不消耗配额、零等待**。

### 三、会员与运营

- **每日配额**：免费用户 1 次/日，会员 10 次/日（按北京时间自然日重置）。
- **付费引导**：免费额度用尽时弹出二维码引导开通会员（¥1 / 天，按月计费，30 天 ¥30）。
  - 配额判定**以服务端 `usage_today()` 为准**，刷新页面无法绕过。
- **管理后台 `/admin`**：邮箱白名单鉴权（服务端校验，前端仅作体验层），可浏览用户列表、
  分析次数、调用次数、注册时间、最近登录，以及查看/修改会员等级与到期倒计时。
- **会员有效期**：`tier=member` 且 `member_expires_at > now()` 才算有效；到期不自动降级，
  仅失活，由运营人决定续费或降级，便于对账。
- **注册风控**：单 IP 每小时上限 + 全站每小时上限；计数异常时宁放行不误挡。

### 四、工程特性

- **零依赖、零构建**：前端原生 HTML / CSS / JS，后端只用 Node 内置模块，无 `node_modules`。
- **本地与线上同一份逻辑**：`lib/` 下的共享库同时被本地后端与 Netlify 函数引用，避免两份实现漂移。
- **严格数据隔离**：数据库启用 RLS + 列级权限 + 守卫触发器；缓存表对客户端完全不可见。
  - 用户无法把自己改成 `member` 或提升配额——`revoke` 列权限与 BEFORE UPDATE 触发器双重拦截。

---

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JS（零依赖；宣纸底 + 楷体 + 印泥红古风） |
| 本地后端 | Node.js 20+ 原生 `http` + `fetch`（`server.local.js`） |
| 线上后端 | Netlify Serverless Functions（`netlify/functions/`） |
| 数据库 / 认证 | Supabase（Postgres + Auth + RLS） |
| 大模型 | DeepSeek-V4.1-Flash（接口 ID `deepseek-flash`） |

> **模型 ID 说明**：DeepSeek 接口只接受小写 ID（`deepseek-flash` / `deepseek-v4-pro`），
> 不接受展示名。代码里用 `MODEL_ALIAS` 做映射，`DEEPSEEK_MODEL` 填展示名或 ID 均可。

---

## 📁 目录结构

```
pingze/
├── 结果/                      # 静态站点发布目录（netlify.toml 里 publish = "结果"）
│   ├── index.html             # 首页：分析界面 + 登录/注册弹层 + 历史/作品面板 + 付费二维码弹层
│   ├── admin.html             # 管理后台页面（/admin）
│   ├── auth.js                # 前端认证与数据层：登录、历史、作品、配额、升级引导
│   ├── admin.js               # 后台逻辑：管理员登录校验 + 用户表渲染 + 改等级
│   ├── supabase-config.example.js  # 前端配置模板（复制为 supabase-config.js 后填真实值）
│   └── 二维码.jpg             # 会员付费引导二维码
├── lib/                       # 本地后端与 Serverless 函数共用的服务端逻辑
│   ├── supabase-store.js      # 缓存 / 配额 / 流水 / 身份校验
│   ├── auth.js                # 注册（绕开 SMTP 限流）+ 风控限流
│   └── admin.js               # 管理员鉴权 + 用户列表 + 改会员等级
├── netlify/functions/         # 线上后端（与本地后端行为一致）
│   ├── analyze.js             # POST /api/analyze
│   ├── register.js            # POST /api/register
│   ├── admin-users.js         # GET  /api/admin-users
│   └── admin-set-tier.js      # POST /api/admin-set-tier
├── supabase/migrations/       # 数据库迁移脚本（按序号顺序执行）
├── scripts/
│   └── gen-supabase-config.js # 构建期生成 结果/supabase-config.js（从环境变量取值，见「部署到 Netlify」）
├── netlify.toml               # 发布目录、函数目录、构建命令、函数超时、路由重写
├── package.json
├── server.local.js            # 本地开发后端（含静态服务，行为对齐 Netlify）
├── .env.example               # 服务端环境变量模板
└── LICENSE
```

---

## 🚀 本地运行

前置：**Node.js 20+**（用到内置 `fetch`，以及 `process.loadEnvFile`）。项目零 npm 依赖，无需 `npm install`。

```bash
# 1. 准备服务端环境变量
cp .env.example .env      # 至少填 DEEPSEEK_API_KEY

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
# {"ok":true,"model":"deepseek-flash","keyReady":true,"supabase":true,"engineVersion":"..."}
```

`keyReady` / `supabase` 可快速判断 `.env` 是否生效。端口被占用时用 `PORT=3001 npm start`。

> 修改**后端**（`server.local.js` / `lib/`）后需重启服务；
> 修改 `结果/` 下的静态文件**不需重启**，刷新浏览器即可（响应带 `Cache-Control: no-cache`）。

---

## 🗄 数据库初始化

1. 在 Supabase 建好项目，取 **Project URL**、**anon public key**（给前端）、**service_role key**（只给服务端）。
2. 打开 **SQL Editor**，按序号顺序逐个粘贴执行 `supabase/migrations/` 下的脚本：

| 脚本 | 作用 |
|---|---|
| `0000_bootstrap_exec_sql.sql` | 创建 `service_role` 专属的 `exec_sql` RPC（后续迁移与后台 SQL 都靠它）。**必须最先执行** |
| `0001_p0_strict.sql` | P0 六张核心表 + RLS 严格隔离（profiles / poems / analyses / analysis_cache / api_usage / feedback） |
| `0002_fix_column_privileges.sql` | 修正列级权限（先收整表再按列放行），彻底挡住用户自我提权 |
| `0003_fix_quota_counting.sql` | 配额口径修正：只统计 `ok` / `timeout`，缓存命中与超限重试不计费 |
| `0004_set_daily_quota_10.sql` | 默认每日配额调整为 10 |
| `0005_simplify_profiles.sql` | 精简 `profiles` 为 `(id, email, created_at)` |
| `0006_membership.sql` | 会员体系：`tier` / `member_since` / `member_expires_at` + 有效会员判定 + 防提权触发器 |

3. 建表后如 REST 接口看不到新表，执行一次 `NOTIFY pgrst, 'reload schema';` 刷新 PostgREST 的 schema 缓存。

> **顺序不能乱**：`0000` 依赖 `service_role`；`0002` 必须在 `0001` 之后（先有表才能改权限）；
> `0006` 重写了 `usage_today()`，必须在 `0004` 之后。

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
| `DEEPSEEK_API_KEY` | DeepSeek API Key | ✅ |
| `SUPABASE_URL` | 项目根地址，**不要带 `/rest/v1`** | ✅ |
| `SUPABASE_SERVICE_KEY` | service_role key，**只放服务端** | ✅ |
| `SUPABASE_ANON_KEY` | anon public key，**构建时注入前端**（不是函数运行时用的） | ✅ |
| `ADMIN_EMAILS` | 管理后台邮箱白名单，逗号分隔。未配置时**任何人都进不去**（fail-closed） | ✅ |
| `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | 默认 `DeepSeek-V4.1-Flash` / `https://api.deepseek.com` | 可选 |
| `REQUIRE_LOGIN` | 默认配了 Supabase 就要求登录；设 `0` 放开匿名 | 可选 |
| `QUOTA_FREE` / `QUOTA_MEMBER` | 免费 / 会员每日配额，须与 `usage_today()` 一致 | 可选 |
| `ANON_DAILY_QUOTA` | 仅 `REQUIRE_LOGIN=0` 时生效的匿名配额 | 可选 |
| `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR` | 注册风控上限 | 可选 |
| `NODE_VERSION` | 建议 `20` | 建议 |

> `SUPABASE_ANON_KEY` 的作用域必须包含 **builds**，否则构建期读不到。

**路由**：`netlify.toml` 把 `/api/*` 重写到 `/.netlify/functions/:splat`，`/admin` 重写到 `/admin.html`。

> **函数超时**：Netlify 免费版硬上限 10 秒，而 DeepSeek 长文本推理容易超过。
> 建议单次提交控制在 40 字以内；Pro 套餐可把 `netlify.toml` 里的 `[functions.<name>] timeout` 提到 26。
> 注意 `functions.timeout` 必须是**逐函数声明的对象**，写成标量会导致 Netlify 拒绝部署。

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

---

## ⚠️ 已知限制

- **注册不校验邮箱真实性**：为绕开 Supabase 默认 SMTP 的严格限流，注册走服务端
  `/api/register` 用 `service_role` 直接建「已确认」账号，因此任何人可用假邮箱注册，
  靠 `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR` 防刷。
  接入自定义 SMTP（需自有域名配 SPF/DKIM/DMARC）后，应恢复邮箱确认并把注册改回 `client.auth.signUp`。
- **免费版函数 10 秒超时**：长文本会被平台中断，前端已给出可操作提示（分批提交）。
- **本仓库只收录程序本体**：批量清库、冒烟测试等运维脚本属于开发过程产物，未纳入。

---

## 📜 许可证

MIT — 可自由用于学习与二次开发，详见 [LICENSE](./LICENSE)。
