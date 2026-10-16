-- ---------------------------------------------------------------------------
-- 0003_fix_quota_counting.sql
--
-- 修复「配额被不该计费的行吃掉」的问题。
--
-- 症状：用户明明只真实调用了 2 次，界面却显示 3/2。
-- 根因有两处，前端 SQL 和后端口径都被算错了：
--
--   1) public.usage_today() 统计 status in ('ok','cache_hit','timeout')
--      → 缓存命中本是零成本的，却被计进了已用额度
--   2) lib/supabase-store.js 的 countUsageToday 干脆不加 status 过滤
--      → 连每次 429 拒绝时写的 'quota_exceeded' 行都算进去，于是越重试数字越大
--
-- 统一口径：**只有真正花了钱的 ok 与 timeout 才计入配额**。
--   · cache_hit      —— 零成本，免费，不计数
--   · quota_exceeded —— 拒绝事件，只用于运营观测，不计数
--   · error/timeout  —— timeout 已发出请求，钱花出去了，计数；error 视情况不计数
--
-- 顺带把兜底日配额从 10 对齐到后端的 DEFAULT_LOGIN_QUOTA = 30。
-- ---------------------------------------------------------------------------

create or replace function public.usage_today()
returns jsonb
language sql
stable
as $$
  with base as (
    select
      coalesce((select daily_quota from public.profiles where id = auth.uid()), 30) as quota,
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
