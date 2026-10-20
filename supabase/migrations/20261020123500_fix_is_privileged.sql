-- =====================================================================
--  收紧 is_privileged()：用「有没有 JWT」代替「有没有 uid」（P3-1）
--
--  背景（2026-10-20 上线前安全审查 P3-1，审查时实测复现）：
--    旧实现的第二个分支是 `when auth.uid() is null then true`，
--    注释写的是「直连 SQL（没有 JWT，auth.uid() 为空）」—— 意图是
--    「运维在 SQL Editor 里直接改数据时算可信方」。
--    但 auth.uid() 为 null 有**两种**完全不同的来源：
--      (a) 根本没有 JWT   —— 直连 SQL / psql，确实该信
--      (b) 有 JWT 但没登录 —— **匿名请求**，PostgREST 对未登录请求会设
--                             request.jwt.claims = {"role":"anon"}，
--                             其中没有 sub ⇒ auth.uid() 为 null
--    旧判断把 (b) 也当成可信方了。
--
--    线上实测复现（在 exec_sql 里把 claims 设成 anon 上下文）：
--        select set_config('request.jwt.claims','{"role":"anon"}',true);
--        select public.jwt_role(), public.is_privileged();
--        → jwt_role = 'anon', is_privileged = true     ★
--
--    当前**不可利用**（profiles 表对 anon / authenticated 都没有 UPDATE 权，
--    实测 has_table_privilege 两者皆 false；guard_membership_columns 只是
--    BEFORE UPDATE 触发器函数，PostgREST 不暴露无参调用）。
--    但这是「一旦有人给 profiles 加一条客户端 UPDATE 路径就立刻变成后门」
--    的那种默认值 —— 与 0001 时代那个已修掉的列级 REVOKE 是同一类隐患。
--
--  修法：改用 jwt_role() 判据。
--    jwt_role() 的取值来自 current_setting('request.jwt.claims')，
--    实测三态：
--        'service_role'  —— 服务端带 service key 调用（exec_sql / 后端 REST）
--        'unknown'       —— **根本没有这个 GUC**，即直连 SQL / SQL Editor
--        'anon' / 'authenticated' —— PostgREST 请求，客户端角色
--    于是：
--        service_role            → 信（真的服务端）
--        unknown（无 JWT）        → 信（真的是直连）
--        anon / authenticated    → **不信**（这正是本次要修的）
--
--    为什么保留 unknown 这一支：SQL Editor / psql 直连是本项目的正规运维
--    入口（迁移就是通过 exec_sql 以 service_role 身份跑的，但人工排查时
--    也会直连）。完全去掉会让直连改不动数据，反而是可用性倒退。
--
--  运行：
--      python db/sb.py sqlfile ../supabase/migrations/20261020123500_fix_is_privileged.sql
--
--  自检（应用后跑，应返回期望值）：
--    -- 匿名上下文（claims={"role":"anon"}）必须返回 false
--    select set_config('request.jwt.claims','{"role":"anon"}',true);
--    select public.jwt_role() as r, public.is_privileged() as p;   -- anon | false
--    -- service_role 上下文仍须为 true（不能把后端自己判成不可信）
--    select public.jwt_role() as r, public.is_privileged() as p;   -- service_role | true
-- =====================================================================

create or replace function public.is_privileged()
returns boolean
language sql
stable
as $$
  -- ★ 判据是「有没有 JWT」，不是「有没有 uid」。
  --   auth.uid() is null 会把「未登录的匿名请求」一并当成可信方 ——
  --   匿名请求的 claims 是 {"role":"anon"}，没有 sub ⇒ uid 为 null。
  --   而 jwt_role() 能把两者分开：'unknown' 才是「根本没有 JWT」。
  --   审查时的实测证据：把 claims 设成 {"role":"anon"} 后，
  --   旧实现 is_privileged() 返回 true（错误）。
  select case
    when public.jwt_role() = 'service_role' then true
    when public.jwt_role() = 'unknown'      then true   -- 直连 SQL / SQL Editor，无 JWT
    else false                               -- anon / authenticated 一律不信
  end;
$$;


-- #####################################################################
-- 权限不变（该函数已在 20261016093000 收口为 owner + service_role），
-- 这里再 revoke 一次是幂等对账，防的是「将来有人 grant 出去」。
-- ★ 又是必须先撤 PUBLIC 的那个坑（见 20261016093000 的 P0-1）。
-- #####################################################################
revoke all on function public.is_privileged() from public;
revoke all on function public.is_privileged() from anon, authenticated;


-- #####################################################################
-- 同步收紧 guard_membership_columns：它自己也应该显式拒绝客户端角色，
-- 而不是把全部判断外包给 is_privileged()。
--   原因：将来若 is_privileged() 被再次放宽（这已经是第二次修它了），
--   触发器这边还有一道独立防线。两处各写一份判断是刻意的 ——
--   这是「纵深防御」，不是重复代码。
--
--   另一处收紧：补上 member_since / tier 之外的列没有遗漏
--   （0006 建的就是这三个字段：tier / member_since / member_expires_at）。
-- #####################################################################
create or replace function public.guard_membership_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role / 直连 SQL（无 JWT）视为可信，允许改
  if public.is_privileged() then
    return new;
  end if;

  -- 客户端一律把特权列还原为旧值（零元升级会员的最后一道闸门）
  if new.tier is distinct from old.tier then
    new.tier := old.tier;
  end if;
  if new.member_since is distinct from old.member_since then
    new.member_since := old.member_since;
  end if;
  if new.member_expires_at is distinct from old.member_expires_at then
    new.member_expires_at := old.member_expires_at;
  end if;
  return new;
end $$;

revoke all on function public.guard_membership_columns() from public;
revoke all on function public.guard_membership_columns() from anon, authenticated;


-- #####################################################################
-- 自检
--
-- 期望 has_function_privilege 全 = false（与 20261016093000 的口径一致）：
--    select has_function_privilege('anon',         'public.is_privileged()',           'execute');  -- false
--    select has_function_privilege('authenticated','public.guard_membership_columns()', 'execute');  -- false
--    select has_function_privilege('service_role', 'public.is_privileged()',           'execute');  -- true
--
-- 期望行为（用 exec_sql 逐条验证）：
--    -- 匿名上下文
--    select set_config('request.jwt.claims','{"role":"anon"}',true);
--    select public.is_privileged();   -- false（修复前是 true）
--    -- 恢复 service_role 上下文后
--    select public.is_privileged();   -- true（后端必须仍能改会员等级）
-- #####################################################################


-- #####################################################################
-- 刷新 PostgREST schema cache
-- #####################################################################
notify pgrst, 'reload schema';
