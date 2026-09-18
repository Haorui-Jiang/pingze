-- =====================================================================
--  0006 · 会员体系（付费功能）
--
--  需求：
--    · 免费用户每天只能分析 1 次；会员用户每天 10 次。
--    · 会员按月计费，以 30 天为限。
--    · profiles 增加「会员等级」与「成为会员时间」。
--
--  设计要点：
--    · tier 用 text 取值 'free' | 'member'，加 check 约束。
--      不用 boolean，是为了将来留出 more 档位（如 'vip'）而不改类型。
--    · member_since       成为会员时间（首次开通/续费时记录）
--      member_expires_at  会员到期时间（= 上次开通 + 30 天）
--      判定「是否有效会员」= tier='member' AND member_expires_at > now()
--      到期后不自动改 tier，仅按上面表达式失活；后台会显示「已过期」，
--      由运营人决定续费或降级（避免后台悄悄篡改用户等级，便于对账）。
--    · usage_today() 按 tier 返回配额：free=1 / member=10
--      —— 前端 auth.js 读它显示「今日用量」，后端 store 另有一套按 tier 计算，
--         两边必须一致（见 lib/supabase-store.js 的 QUOTA_BY_TIER）。
--    · 安全：tier / member_since / member_expires_at 属于「特权列」，
--      登录用户绝不能自行 PATCH（否则可零元升级）。列级权限 + 触发器双保险。
--
--  运行（工作区助手）：python db/sb.py sqlfile migrations/0006_membership.sql
-- =====================================================================

-- 1) 会员字段 -----------------------------------------------------------
alter table public.profiles
  add column if not exists tier text not null default 'free',
  add column if not exists member_since timestamptz,
  add column if not exists member_expires_at timestamptz;

-- tier 只允许 free / member
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_tier_check'
       and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_tier_check check (tier in ('free', 'member'));
  end if;
end $$;

-- 便于后台按等级筛选 / 统计
create index if not exists profiles_tier_idx on public.profiles (tier);

-- 2) usage_today()：按会员等级返回每日配额 ------------------------------
--    free   → 1 次/天
--    member → 10 次/天（且会员未过期）
create or replace function public.usage_today()
returns jsonb
language sql
stable
as $$
  with me as (
    select
      case
        when p.tier = 'member'
             and p.member_expires_at is not null
             and p.member_expires_at > now()
          then 10
        else 1
      end as quota,
      coalesce(p.tier, 'free') as tier,
      p.member_expires_at
    from public.profiles p
    where p.id = auth.uid()
  ),
  base as (
    select
      (select quota from me) as quota,
      (select tier  from me) as tier,
      (select member_expires_at from me) as member_expires_at,
      (select count(*)::int
         from public.api_usage
        where user_id = auth.uid()
          and (created_at at time zone 'Asia/Shanghai')::date
              = (now()      at time zone 'Asia/Shanghai')::date
          -- 只计真正消耗额度的调用，缓存命中与限流拒绝都不算
          and status in ('ok', 'timeout')) as used
  )
  select jsonb_build_object(
           'quota',          coalesce(quota, 1),
           'used',           coalesce(used, 0),
           'remaining',      greatest(0, coalesce(quota, 1) - coalesce(used, 0)),
           'tier',           coalesce(tier, 'free'),
           'member_expires_at', member_expires_at
         )
  from base;
$$;

-- 3) 特权列保护：登录用户不可自行修改等级/会员时间 ----------------------
--    背景：profiles 上有「本人可改档」UPDATE 策略（auth.uid() = id），
--    若不额外设防，用户可 PATCH 自己为 member 实现零元升级。
--    这里用触发器把特权列「还原为旧值」，双保险（配合第 4 步的列级收权）。
create or replace function public.guard_membership_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role / 直连 SQL 视为可信，允许改
  if public.is_privileged() then
    return new;
  end if;

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
end;
$$;

drop trigger if exists trg_profiles_membership_guard on public.profiles;
create trigger trg_profiles_membership_guard
  before update on public.profiles
  for each row execute function public.guard_membership_columns();

-- 4) 列级收权：authenticated 不得 INSERT/UPDATE 任何 profiles 列 ---------
--    0005 已 revoke update，这里再补一层，确保新增的会员列同样不可写。
--    注意顺序：PostgreSQL 的列级 REVOKE 对「表级授权」是静默 no-op，
--    必须先收回表级，再按列放行（本项目 0002 踩过此坑）。
revoke insert, update on public.profiles from authenticated;
revoke insert, update on public.profiles from anon;

-- 5) 刷新 PostgREST schema cache ---------------------------------------
notify pgrst, 'reload schema';
