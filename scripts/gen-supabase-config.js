#!/usr/bin/env node
/**
 * 生成前端 Supabase 配置（构建期注入）
 *
 * 为什么需要它：`结果/supabase-config.js` 含真实 Project URL 与 anon key，
 * 被 .gitignore 排除、不进仓库（`tools/sync-pingze.js` 每次同步都会断言它不存在）。
 * 但 Netlify 是从 Git 仓库构建的 —— 不生成这个文件，线上就会 404，
 * 前端 `PingzeAuth.ready=false`，页面显示「账号功能未启用」。
 *
 * 因此改为：Netlify 构建时从**环境变量**取真实值，现场写出这个文件。
 * 密钥只存在于 Netlify 环境变量里，仓库始终干净。
 *
 * ---------------------------------------------------------------------------
 * 在 Netlify 侧需要配置（Site settings → Environment variables）：
 *   SUPABASE_URL        https://<project-ref>.supabase.co   （已存在，直接复用）
 *   SUPABASE_ANON_KEY   anon public key（208 字符左右的 JWT）
 *
 * netlify.toml:
 *   [build]
 *     command = "node scripts/gen-supabase-config.js"
 * ---------------------------------------------------------------------------
 *
 * 本地开发不需要跑它：`结果/supabase-config.js` 已在工作区里，`npm start` 直接可用。
 * 若手动运行（例如想验证 Netlify 的构建行为），在**仓库根目录**执行：
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/gen-supabase-config.js
 *
 * 任何一项缺失或校验失败都会 **exit 1** —— 让 Netlify 构建直接失败，
 * 而不是静默产出一个空配置、让线上又退回「账号功能未启用」。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // 本脚本位于 scripts/，仓库根在其上一级
const OUT = path.join(ROOT, '结果', 'supabase-config.js');

const url = String(process.env.SUPABASE_URL || '').trim();
const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

function die(msg) {
  console.error('[gen-supabase-config] 失败：' + msg);
  process.exit(1);
}

// ---------- 1. 必备项 ----------
if (!url) die('缺少环境变量 SUPABASE_URL（Netlify → Site settings → Environment variables）');
if (!anonKey) {
  die(
    '缺少环境变量 SUPABASE_ANON_KEY。\n' +
      '    取值：Supabase 后台 → Project Settings → API → anon public key。\n' +
      '    注意必须是 anon key，不能是 service_role key。'
  );
}

// ---------- 2. URL 形状 ----------
const m = url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co$/);
if (!m) {
  die(
    'SUPABASE_URL 形状不对：' + url + '\n' +
      '    期望形如 https://<project-ref>.supabase.co，不要带 /rest/v1 后缀或结尾斜杠。'
  );
}
const refFromUrl = m[1];

// ---------- 3. key 必须是合法 JWT，且角色必须是 anon ----------
let payload;
try {
  const seg = anonKey.split('.')[1];
  if (!seg) throw new Error('不是三段式 JWT');
  payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
} catch (e) {
  die('SUPABASE_ANON_KEY 不是合法的 JWT：' + e.message);
}

if (payload.role !== 'anon') {
  die(
    'SUPABASE_ANON_KEY 的 role 是 "' + payload.role + '"，只允许 "anon"。\n' +
      '    这条闸门是为了防止把 service_role key 误注入前端 —— 那个 key 绕过一切 RLS，\n' +
      '    一旦出现在浏览器里就等于把整个数据库公开了。'
  );
}

// ---------- 4. URL 与 key 必须指向同一个项目 ----------
if (payload.ref && payload.ref !== refFromUrl) {
  die(
    '项目不匹配：SUPABASE_URL 的 ref = ' + refFromUrl +
      '，但 anon key 的 ref = ' + payload.ref + '。\n' +
      '    两者必须来自同一个 Supabase 项目。'
  );
}

// ---------- 5. 写文件 ----------
const content = `/**
 * Supabase 前端配置
 *
 * ⚠️ 本文件由构建过程自动生成（仓库里的 scripts/gen-supabase-config.js），
 *    请勿手动编辑 —— 下次构建会被覆盖。
 *
 * 值的来源：Netlify 环境变量 SUPABASE_URL / SUPABASE_ANON_KEY。
 * 之所以不在仓库里保存这个文件，是因为它含真实配置；
 * 这里只能出现 anon key（公开可见、由 RLS 保护数据），
 * 绝不能出现 service_role key。
 */
window.PINGZE_SUPABASE = {
  url: '${url}',
  anonKey: '${anonKey}',
};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, content, 'utf8');

console.log(
  '[gen-supabase-config] 已生成 ' + path.relative(ROOT, OUT) +
    '（' + Buffer.byteLength(content, 'utf8') + ' B，project ref = ' + refFromUrl + '，role = anon）'
);
