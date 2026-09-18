-- =====================================================================
--  0005 · 精简 profiles 表
--
--  背景：注册界面仅为「邮箱 + 密码」，profiles 里大量字段
--        (display_name / avatar_url / bio / default_rhyme_book /
--         default_mode / plan / daily_quota / role / updated_at)
--        纯属冗余。本迁移把它们全部删除，仅保留：
--          · id          uuid 主键（即「必要的索引」）
--          · email       text（从 auth.users 镜像过来，登录身份）
--          · created_at  timestamptz（注册时间，限流计数口径依赖它）
--
--  配套改动（不破坏现有功能）：
--    · 删除依赖被移除列的 guard_privileged_columns() 及其触发器
--    · is_privileged() 不再依赖 profiles.role
--    · usage_today() 不再读 profiles.daily_quota，每日额度固定 10
--      （与后端 lib/supabase-store.js 的 DEFAULT_LOGIN_QUOTA 对齐）
--    · handle_new_user() 只写入 (id, email)
--    · 收回客户端对 profiles 的列级 UPDATE 授权（极小化档案）
--
--  运行：python sb.py sqlfile supabase/0005_simplify_profiles.sql
--  （exec_sql 以 security definer 执行，整段 DDL 原子提交；任意一步失败自动回滚）
-- =====================================================================

-- 1) 删除依赖被移除列的触发器与函数 -------------------------------------
drop trigger if exists trg_profiles_guard   on public.profiles;
drop trigger if exists trg_profiles_updated on public.profiles;
drop function  if exists public.guard_privileged_columns() cascade;

-- 2) is_privileged()：去掉 profiles.role 的依赖 -------------------------
--    role 列将被删除，这里只保留「service_role / 直连 SQL」两种可信来源。
create or replace function public.is_privileged()
returns boolean
language sql
stable
as $$
  select case
    when public.jwt_role() = 'service_role' then true
    when auth.uid() is null                 then true
    else false
  end;
$$;

-- 3) usage_today()：不再依赖 profiles.daily_quota，每日额度固定 10 ------
--    前端 auth.js 通过 client.rpc('usage_today') 读取 used/quota/remaining，
--    返回结构必须保持 { used, quota, remaining } 不变。
create or replace function public.usage_today()
returns jsonb
language sql
stable
as $$
  with base as (
    select
      10 as quota,
      (select count(*)::int
         from public.api_usage
        where user_id = auth.uid()
          and (created_at at time zone 'Asia/Shanghai')::date
              = (now()      at time zone 'Asia/Shanghai')::date
          -- 只计真正消耗额度的调用，缓存命中与限流拒绝都不算
          and status in ('ok', 'timeout')) as used
  )
  select jsonb_build_object(
           'quota',     quota,
           'used',      used,
           'remaining', greatest(0, quota - used)
         )
  from base;
$$;

-- 4) 精简 profiles 表 ----------------------------------------------------
alter table public.profiles
  drop column if exists display_name,
  drop column if exists avatar_url,
  drop column if exists bio,
  drop column if exists default_rhyme_book,
  drop column if exists default_mode,
  drop column if exists plan,
  drop column if exists daily_quota,
  drop column if exists role,
  drop column if exists updated_at;

-- email 字段当前 profiles 表中并不存在，这里补上（从 auth.users 镜像）
alter table public.profiles
  add column if not exists email text;

-- 必要的索引：email 上加唯一索引，既保证「一个邮箱一个档案」，
-- 也便于按邮箱定位。（id 主键本身已是最必要的索引）
create unique index if not exists profiles_email_key
  on public.profiles (email) where email is not null;

-- 5) handle_new_user()：只写入 (id, email) ------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
exception when others then
  -- 极端情况下（如 email 缺失）仍要保证建档，避免注册失败
  begin
    insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  exception when others then end;
  return new;
end;
$$;

-- 6) 收掉客户端对 profiles 的列级 UPDATE 授权 ---------------------------
--    原 0002 针对 display_name 等的列级 grant 已随列删除失效；
--    这里显式收回整表 UPDATE，档案极小化：登录用户不可改任何档案字段
--    （email 由 auth 体系管理，created_at 只读）。
revoke update on public.profiles from authenticated;

-- 7) 让 PostgREST 重新加载 schema（DDL 后必须）
notify pgrst, 'reload schema';
