-- =====================================================================
--  0007 · V5 改造：删除 AI 分析时代的 5 张业务表，仅留用户表
--
--  背景（2026-10-16 V5，详见根目录 tasks.md）：
--    · AI 判平仄不可靠 → 平仄/韵部查询改为前端本地查表
--      （结果/pingze-engine.js + pingshui-yun-data.js，零服务端成本），
--      不再产生任何「分析流水 / 结果缓存 / 用量流水」数据。
--    · 鉴赏类窗口（我的分析 / 我的作品）随之下线，poems 表删除。
--    · AI 改作查询完成后的增值功能（平仄分析 + 诗词鉴赏，双开关、
--      仅开启才调用），配额改存 profiles 的两个轻量列，
--      不再需要 api_usage 流水表。
--    · 新增 queries 表：登录用户的查询记录（RLS 严格隔离，本人可读/建/删）。
--
--  删除（外键序）：analyses → poems → analysis_cache → api_usage → feedback
--  保留：auth.users / public.profiles（用户表）及其会员字段
--
--  运行（前提已执行 0000_bootstrap_exec_sql.sql）：
--      python db/sb.py sqlfile ../supabase/migrations/0007_v5_query_engine.sql
-- =====================================================================

-- 1) 先删依赖被删表的触发器与函数 --------------------------------------
--    （表删了函数还在会变成孤儿，且 usage_today 读 api_usage，留着他必报错）
drop trigger if exists trg_analyses_touch_poem on public.analyses;
drop trigger if exists trg_poems_updated       on public.poems;
drop function if exists public.after_analysis_insert() cascade;
drop function if exists public.guard_feedback_state()    cascade;
drop function if exists public.usage_today()             cascade;
-- poems 是 set_updated_at 的唯一使用者，表删后它也成为孤儿
drop function if exists public.set_updated_at()          cascade;

-- 2) 删除 5 张业务表（严格按外键依赖序）---------------------------------
--    analyses 同时引用 poems 与 analysis_cache，必须第一个删
drop table if exists public.analyses;
drop table if exists public.poems;
drop table if exists public.analysis_cache;
drop table if exists public.api_usage;
drop table if exists public.feedback;

-- 3) 新建 queries —— 登录用户的查询记录 ---------------------------------
--    与 poems/analyses 的本质区别：只存「查表输入 + 查表结果」，
--    不存任何 AI 生成内容；记录不可改（没有 UPDATE 授权），只能删。
create table if not exists public.queries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  input_text  text not null check (char_length(input_text) between 1 and 1000),
  result      jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_queries_user_recent on public.queries (user_id, created_at desc);

alter table public.queries enable row level security;

drop policy if exists "本人可读查询记录" on public.queries;
create policy "本人可读查询记录" on public.queries for select using (auth.uid() = user_id);
drop policy if exists "本人可建查询记录" on public.queries;
create policy "本人可建查询记录" on public.queries for insert with check (auth.uid() = user_id);
drop policy if exists "本人可删查询记录" on public.queries;
create policy "本人可删查询记录" on public.queries for delete using (auth.uid() = user_id);

-- 与 feedback/poems 一致的做法：anon 一律摸不到，authenticated 不给 UPDATE
revoke all    on public.queries from anon;
revoke update on public.queries from authenticated;

-- 4) profiles：AI 配额轻量计数 ------------------------------------------
--    取代 api_usage 流水表。按北京时间自然日重置（见下面两个函数）：
--      free   → 3 次/天
--      member → 10 次/天（tier='member' 且未过期）
--    查表功能本身永久免费、不计次。
alter table public.profiles
  add column if not exists ai_used_date  date,
  add column if not exists ai_used_count int not null default 0;

-- 5) ai_usage_today()：前端登录后自助读取，展示「AI 赏析剩余次数」--------
create or replace function public.ai_usage_today()
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
        else 3
      end as quota,
      case
        when p.ai_used_date = (now() at time zone 'Asia/Shanghai')::date
          then coalesce(p.ai_used_count, 0)
        else 0
      end as used
    from public.profiles p
    where p.id = auth.uid()
  )
  select jsonb_build_object(
           'quota',     coalesce((select quota from me), 3),
           'used',      coalesce((select used  from me), 0),
           'remaining', greatest(0, coalesce((select quota from me), 3)
                                     - coalesce((select used  from me), 0))
         );
$$;

revoke execute on function public.ai_usage_today() from anon;

-- 6) ai_quota_consume(p_user_id)：服务端原子「检查 + 扣减」---------------
--    由后端用 service_role 调用（传解析出的 user_id），登录用户不可调
--    （否则可零元改配额）。先查后扣在一个事务里完成，避免并发超发。
create or replace function public.ai_quota_consume(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me    record;
  today date := (now() at time zone 'Asia/Shanghai')::date;
  quota int;
  used  int;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_user');
  end if;

  select * into me from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  quota := case
    when me.tier = 'member'
         and me.member_expires_at is not null
         and me.member_expires_at > now()
      then 10
    else 3
  end;

  -- 跨天自动重置：日期不是今天就当 0 次已用
  if me.ai_used_date = today then
    used := coalesce(me.ai_used_count, 0);
  else
    used := 0;
  end if;

  if used >= quota then
    return jsonb_build_object('allowed', false, 'used', used, 'quota', quota, 'remaining', 0);
  end if;

  update public.profiles
     set ai_used_date  = today,
         ai_used_count = used + 1
   where id = p_user_id;

  return jsonb_build_object('allowed', true, 'used', used + 1, 'quota', quota,
                            'remaining', quota - used - 1);
end $$;

revoke execute on function public.ai_quota_consume(uuid) from anon, authenticated;

-- 7) 刷新 PostgREST schema cache ---------------------------------------
notify pgrst, 'reload schema';
