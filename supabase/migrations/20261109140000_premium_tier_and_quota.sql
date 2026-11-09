-- =====================================================================
--  20261109140000 · AI 每日配额调整 + 新增「特级会员」（premium）
--
--  2026-11-09 需求：
--    · 免费用户    free     每日  10 次（原 3 次）
--    · 会员        member   每日  50 次（原 10 次），¥20 / 月
--    · 特级会员    premium  每日不限次（新增档位），¥50 / 月
--
--  设计要点：
--    1) tier 的 check 约束扩为 free | member | premium（0006 只允两档）。
--    2) ★ 配额口径只写一份：新建 ai_daily_quota(tier, expires_at) 纯计算函数，
--       返回 -1 表示「不限次」；ai_usage_today() 与 ai_quota_consume() 都调它。
--       旧实现在两个 RPC 里各写一份 case，改一边就会静默错配。
--       跨文件一致性由 tools/verify-quota.js 断言（DB / 后端 / 前端 / README）。
--    3) 两个 RPC 的回包新增 tier / unlimited：后端与前端不再靠
--       「quota >= 10 猜是不是会员」——免费额度提到 10 后，旧猜法必然误判。
--    4) 不限次仍照常累加 ai_used_count：运营后台要能看到真实用量，
--       也便于随时降级回限量档而不丢计数。
--    5) 有效期判定不变：付费档必须 member_expires_at > now() 才生效；
--       过期一律回落到 free 档（10 次/天），不自动改 tier，便于对账。
--    6) IP 级限流（20 次/分钟）与每日配额是两道并行护栏，本迁移不动——
--       特级会员「每日次数不限」不等于可以无限速刷接口。
--
--  ★ 本迁移是「追加」：0006 / 0007 等历史迁移永不修改。
--  应用：python db/sb.py sqlfile ../supabase/migrations/20261109140000_premium_tier_and_quota.sql
-- =====================================================================

-- 1) tier 枚举扩容 ------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_tier_check;
alter table public.profiles
  add constraint profiles_tier_check check (tier in ('free', 'member', 'premium'));

-- 2) 单一权威口径：按等级返回每日配额（-1 = 不限次）----------------------
create or replace function public.ai_daily_quota(p_tier text, p_expires_at timestamptz)
returns int
language sql
stable
as $$
  select case
    when p_tier = 'premium'
         and p_expires_at is not null and p_expires_at > now() then -1
    when p_tier = 'member'
         and p_expires_at is not null and p_expires_at > now() then 50
    else 10
  end
$$;

revoke all on function public.ai_daily_quota(text, timestamptz) from public;
revoke all on function public.ai_daily_quota(text, timestamptz) from anon, authenticated;
-- ai_usage_today() 是 security invoker：登录用户调用时，函数体在调用者权限下
-- 执行，故必须给 authenticated 执行权。该函数是纯计算、不访问任何表，
-- 不会扩大数据访问面；anon / PUBLIC 一律不给。
grant execute on function public.ai_daily_quota(text, timestamptz) to authenticated, service_role;

-- 3) ai_usage_today()：前端登录后自助读取 --------------------------------
create or replace function public.ai_usage_today()
returns jsonb
language sql
stable
as $$
  with me as (
    select
      public.ai_daily_quota(coalesce(p.tier, 'free'), p.member_expires_at) as quota,
      coalesce(p.tier, 'free') as tier,
      case
        when p.ai_used_date = (now() at time zone 'Asia/Shanghai')::date
          then coalesce(p.ai_used_count, 0)
        else 0
      end as used
    from public.profiles p
    where p.id = auth.uid()
  )
  select jsonb_build_object(
           'quota',     coalesce((select quota from me), 10),
           'used',      coalesce((select used  from me), 0),
           'remaining', case when coalesce((select quota from me), 10) < 0 then -1
                             else greatest(0, coalesce((select quota from me), 10)
                                              - coalesce((select used from me), 0)) end,
           'tier',      coalesce((select tier from me), 'free'),
           'unlimited', coalesce((select quota from me), 10) < 0
         )
$$;

revoke all on function public.ai_usage_today() from public;
revoke all on function public.ai_usage_today() from anon;
grant execute on function public.ai_usage_today() to authenticated, service_role;

-- 4) ai_quota_consume(uuid)：服务端原子「检查 + 扣减」--------------------
--    quota < 0 ⇒ 跳过 used >= quota 判断，永远放行；计数照常累加。
create or replace function public.ai_quota_consume(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me      record;
  today   date := (now() at time zone 'Asia/Shanghai')::date;
  v_tier  text;
  v_quota int;
  v_used  int;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_user');
  end if;

  select * into me from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  v_tier  := coalesce(me.tier, 'free');
  v_quota := public.ai_daily_quota(v_tier, me.member_expires_at);

  -- 跨天自动重置：日期不是今天就当 0 次已用
  if me.ai_used_date = today then
    v_used := coalesce(me.ai_used_count, 0);
  else
    v_used := 0;
  end if;

  if v_quota >= 0 and v_used >= v_quota then
    return jsonb_build_object('allowed', false, 'used', v_used, 'quota', v_quota,
                              'remaining', 0, 'tier', v_tier, 'unlimited', false);
  end if;

  update public.profiles
     set ai_used_date  = today,
         ai_used_count = v_used + 1
   where id = p_user_id;

  return jsonb_build_object(
           'allowed',   true,
           'used',      v_used + 1,
           'quota',     v_quota,
           'remaining', case when v_quota < 0 then -1 else v_quota - v_used - 1 end,
           'tier',      v_tier,
           'unlimited', v_quota < 0
         );
end $$;

revoke all on function public.ai_quota_consume(uuid) from public;
revoke all on function public.ai_quota_consume(uuid) from anon, authenticated;
grant execute on function public.ai_quota_consume(uuid) to service_role;

-- 5) 刷新 PostgREST schema cache（约束与函数签名都变了）------------------
notify pgrst, 'reload schema';
