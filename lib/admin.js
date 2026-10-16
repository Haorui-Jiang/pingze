'use strict';

/**
 * 后台管理模块 —— 被两个后端共用
 *   · server.local.js                 （本地常驻进程）
 *   · netlify/functions/admin-users.js（Serverless 函数）
 *
 * 只用 Node 18+ 内置能力（fetch），不引入任何 npm 依赖，保持「零依赖」。
 *
 * 设计要点：
 *   1. 管理员由「邮箱白名单」认定：环境变量 ADMIN_EMAILS（逗号分隔）。
 *      —— 对应需求「仅限 Supabase 项目管理员账号登录」。
 *      —— 未配置 ADMIN_EMAILS 时 fail-closed：任何人都进不来（安全默认）。
 *   2. 校验链路：前端传来的 JWT → 服务端用 service_role 调 /auth/v1/user 重新校验
 *      （由 Supabase 验签 + 验过期），拿到 email 后再比对白名单。
 *      绝不在前端做权限判断，前端只是体验层。
 *   3. 取数走 exec_sql（service_role SECURITY DEFINER），可跨 auth / public schema
 *      聚合并返回 JSON，避免逐表拉取。
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const AUTH_URL = SUPABASE_URL + '/auth/v1';
const REST_URL = SUPABASE_URL + '/rest/v1';

/** 没配 Supabase 时整套后台不可用，但也不要崩，给调用方降级信号 */
const ENABLED = Boolean(SUPABASE_URL && SERVICE_KEY);

/** 返回小写、去空白、非空的白名单邮箱数组 */
function getAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 用前端传来的 JWT 校验管理员身份。
 * 返回:
 *   { ok: true, email, id }                       —— 是白名单管理员
 *   { ok: false, reason }                          —— 非管理员 / 未登录 / 未配置
 * reason 取值：no-auth | invalid-token | no-admins-configured | not-admin | error
 */
async function verifyAdmin(token) {
  if (!ENABLED || !token) return { ok: false, reason: 'no-auth' };
  try {
    const res = await fetch(AUTH_URL + '/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return { ok: false, reason: 'invalid-token' };
    const user = await res.json();
    if (!user || !user.id) return { ok: false, reason: 'invalid-token' };

    const emails = getAdminEmails();
    if (!emails.length) return { ok: false, reason: 'no-admins-configured' };

    const email = String(user.email || '').toLowerCase();
    if (!emails.includes(email)) return { ok: false, reason: 'not-admin' };

    return { ok: true, email: user.email, id: user.id };
  } catch (e) {
    return { ok: false, reason: 'error: ' + (e && e.message ? e.message : e) };
  }
}

/**
 * 列出全站用户信息 + 各表统计 + 会员状态，供管理后台浏览。
 * 通过 exec_sql（service_role）直接跨 schema 聚合，返回 JSON 数组。
 *
 * 字段：
 *   id / email / created_at（注册时间）/ last_sign_in_at（最近登录）
 *   confirmed_at（确认状态）/ provider（来源）/ query_count（查询记录数）
 *   ai_used_today（今日 AI 赏析用量，北京时间自然日）
 *   tier（等级 free/member）/ member_since（成为会员时间）
 *   member_expires_at（到期时间）/ member_days_left（剩余天数，含负值=已过期）
 *   member_active（是否有效会员）
 *
 * V5 起（2026-10-16）：analyses / api_usage 表已删（迁移 0007）——
 *   分析次数改数 queries 表（查询记录），API 调用改读 profiles 的
 *   ai_used_date / ai_used_count 轻量计数列。
 */
const LIST_SQL = [
  'SELECT',
  '  u.id,',
  '  u.email,',
  '  u.created_at,',
  '  u.last_sign_in_at,',
  '  u.confirmed_at,',
  "  u.raw_app_meta_data->>'provider' AS provider,",
  '  (SELECT count(*) FROM public.queries q WHERE q.user_id = u.id)::int AS query_count,',
  '  case when p.ai_used_date = (now() at time zone \'Asia/Shanghai\')::date',
  '       then coalesce(p.ai_used_count, 0) else 0 end::int AS ai_used_today,',
  "  coalesce(p.tier, 'free') AS tier,",
  '  p.member_since,',
  '  p.member_expires_at,',
  // 剩余天数：向上取整；已过期返回负数（前端据此显示「已过期」）
  '  case when p.member_expires_at is null then null',
  '       else ceil(extract(epoch from (p.member_expires_at - now())) / 86400.0)::int',
  '  end AS member_days_left,',
  "  (coalesce(p.tier,'free') = 'member' and p.member_expires_at is not null",
  '     and p.member_expires_at > now()) AS member_active',
  'FROM auth.users u',
  'LEFT JOIN public.profiles p ON p.id = u.id',
  'ORDER BY u.created_at DESC',
  'LIMIT ',
].join(' ');

async function listUsers(limit) {
  limit = Number(limit) || 200;
  const sql = LIST_SQL + limit;
  const rows = await execSql(sql);
  if (!Array.isArray(rows)) return [];
  return rows;
}

/**
 * 统一的 exec_sql 调用。
 * 注意：报错里**不要带上游原文**（P2-3 同理）—— 上游错误可能含 SQL 片段、
 * 表名、内部 id。这些只进服务端日志，返回给调用方的必须是脱敏后的短句。
 */
async function execSql(sql) {
  const res = await fetch(REST_URL + '/rpc/exec_sql', {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[admin] exec_sql HTTP ' + res.status + ': ' + String(detail).slice(0, 500));
    throw new Error('数据库请求失败（HTTP ' + res.status + '），请稍后重试。');
  }
  const data = await res.json();
  if (data && data.error) {
    // 业务层错误（exec_sql 捕获 SQL 异常后返回 {error, message, code}）：
    // message 是 SQLERRM，可能是约束名/列名，同样只进日志。
    console.error('[admin] exec_sql 错误: ' + JSON.stringify(data));
    throw new Error('数据库操作失败，请检查参数后重试。');
  }
  return data;
}

/**
 * 修改某用户的会员等级（运营人操作）。
 *   tier = 'member' 时：设置 member_since（首次则记录为现在，续费则保留首次时间）
 *                       与 member_expires_at = 现在 + days 天（续费从「当前到期时间」顺延）
 *   tier = 'free'   时：清空会员时间字段
 *
 * 注意：写操作走 service_role（exec_sql 是 security definer），
 * 因此不受 RLS 与列级权限限制；这也是唯一能改 tier 的合法途径。
 */
const RENEW_DAYS = 30;

async function setTier(userId, tier, days) {
  if (tier !== 'free' && tier !== 'member') {
    throw new Error("tier 只能是 'free' 或 'member'");
  }
  days = Number(days) || RENEW_DAYS;
  // uuid 基本校验，防注入（exec_sql 是字符串拼 SQL，务必过滤）
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(userId))) {
    throw new Error('userId 不是合法 UUID');
  }
  const uid = String(userId);

  let sql;
  if (tier === 'member') {
    // 续费逻辑：已是会员且未过期 → 从原到期时间顺延；否则从现在起算
    sql =
      'update public.profiles set ' +
      "  tier = 'member', " +
      '  member_since = coalesce(member_since, now()), ' +
      '  member_expires_at = ' +
      '    case when member_expires_at is not null and member_expires_at > now() ' +
      "         then member_expires_at + interval '" + days + " days' " +
      "         else now() + interval '" + days + " days' end " +
      "where id = '" + uid + "'";
  } else {
    sql =
      'update public.profiles set ' +
      "  tier = 'free', member_since = null, member_expires_at = null " +
      "where id = '" + uid + "'";
  }
  // 注意：exec_sql 对 DML 走 `execute query` 分支，只回 {"ok":true}，不回 RETURNING 行。
  // 因此更新后用一条 SELECT 读回结果，前端才能拿到最新值。
  await execSql(sql);

  const back = await execSql(
    'SELECT id, tier, member_since, member_expires_at FROM public.profiles ' +
    "WHERE id = '" + uid + "' LIMIT 1"
  );
  if (!Array.isArray(back) || !back.length) {
    throw new Error('未找到该用户档案（auth.users 存在但 profiles 缺失？）');
  }
  return back[0];
}

module.exports = {
  ENABLED: ENABLED,
  RENEW_DAYS: RENEW_DAYS,
  getAdminEmails: getAdminEmails,
  verifyAdmin: verifyAdmin,
  listUsers: listUsers,
  setTier: setTier,
};
