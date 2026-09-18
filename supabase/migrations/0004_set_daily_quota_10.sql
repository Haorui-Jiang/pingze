-- ---------------------------------------------------------------------------
-- 0004_set_daily_quota_10.sql
--
-- 登录用户的每日分析额度：30 → 10
--
-- 三个地方都必须改，漏一处就会出现「前端显示 10、后端按 30 放行」的错配：
--   1) profiles.daily_quota 的列默认值   —— 决定新注册用户拿到多少
--   2) 已有行的数据                        —— 决定存量用户是多少
--   3) usage_today() 的兜底值              —— 决定查不到 profile 时按多少算
-- 另：lib/supabase-store.js 的 DEFAULT_LOGIN_QUOTA 是第四处，在代码里改。
--
-- 存量用户只降 free 档，不动 pro / 付费档，避免把老用户越改越差。
-- ---------------------------------------------------------------------------

alter table public.profiles
  alter column daily_quota set default 10;

update public.profiles
   set daily_quota = 10
 where plan = 'free'
   and daily_quota <> 10;

create or replace function public.usage_today()
returns jsonb
language sql
stable
as $$
  with base as (
    select
      coalesce((select daily_quota from public.profiles where id = auth.uid()), 10) as quota,
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
