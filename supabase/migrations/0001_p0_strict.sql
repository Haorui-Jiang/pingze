-- =====================================================================
--  平仄格律查询 · P0 上线必备 6 张表
--  隔离级别：严格。用户只能读写自己的数据，看不到任何别人的一行。
--
--  运行方式（前提已执行 0000_bootstrap_exec_sql.sql）：
--      （工作区助手）python db/sb.py sqlfile migrations/0001_p0_strict.sql
--
--  表清单：
--    profiles          用户档案（配额 / 偏好）
--    poems             作品本体
--    analyses          分析流水（个人时间线）
--    analysis_cache    结果缓存（服务端专用，客户端不可见）
--    api_usage         配额与成本流水（服务端写，本人可读）
--    feedback          反馈与数据报错
-- =====================================================================

create extension if not exists pgcrypto;

-- 通用：自动维护 updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;


-- ---------------------------------------------------------------------
--  特权字段防护
--  RLS 只能控制「哪一行」，管不了「哪一列」。
--  若不额外处理，登录用户可以 PATCH 自己的 profile 把 plan 改成 pro。
--  两层防护：列级 revoke（客户端直接报权限错）+ 触发器兜底（任何路径都拦得住）
-- ---------------------------------------------------------------------
create or replace function public.jwt_role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    'unknown'
  );
$$;

-- plan / daily_quota / role 只允许可信方改动。
-- 没有这层的话，登录用户可以 PATCH 自己的档案把 plan 直接改成 pro。
create or replace function public.guard_privileged_columns()
returns trigger language plpgsql as $$
begin
  if new.plan        is distinct from old.plan
     or new.daily_quota is distinct from old.daily_quota
     or new.role        is distinct from old.role then

    if not public.is_privileged() then
      new.plan        := old.plan;
      new.daily_quota := old.daily_quota;
      new.role        := old.role;
    end if;
  end if;
  return new;
end $$;


-- #####################################################################
--  1. profiles —— 用户档案
--  不自建 users 表。主键直接引用 auth.users.id，注册由触发器自动建档。
-- #####################################################################
create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  display_name      text unique check (char_length(display_name) between 1 and 24),
  avatar_url        text,
  bio               text check (char_length(bio) <= 200),

  -- 产品偏好
  default_rhyme_book text not null default 'pingshui'
    check (default_rhyme_book in ('pingshui', 'xinyun', 'both')),
  default_mode       text not null default 'both'
    check (default_mode in ('gu', 'jin', 'both')),

  -- 订阅与配额：接支付后再升级到独立的 subscriptions 表
  plan              text not null default 'free'
    check (plan in ('free', 'pro', 'lifetime')),
  daily_quota       int  not null default 30,

  role              text not null default 'user'
    check (role in ('user', 'editor', 'admin')),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- 判断当前操作者是不是「可信方」：
--   · service_role（服务端密钥）
--   · 直连 / SQL Editor（没有 JWT，auth.uid() 为空）
--   · profiles.role 为 admin / editor 的运营账号
-- 必须放在 profiles 建好之后：部分 Postgres 版本在创建 SQL 函数时
-- 就会解析表引用，提前定义会报 relation does not exist。
create or replace function public.is_privileged()
returns boolean
language sql
stable
as $$
  select case
    when public.jwt_role() = 'service_role' then true
    when auth.uid() is null                 then true
    else exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role in ('admin', 'editor'))
  end;
$$;

create trigger trg_profiles_updated
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger trg_profiles_guard
  before update on public.profiles
  for each row execute function public.guard_privileged_columns();

-- 注册即建档（security definer，绕过 RLS）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    insert into public.profiles (id, display_name, avatar_url)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'display_name',
               '诗友' || substr(replace(new.id::text, '-', ''), 1, 6)),
      coalesce(new.raw_user_meta_data->>'avatar_url', '')
    );
  exception when unique_violation then
    -- display_name 撞名时退回随机后缀，不能让注册失败
    insert into public.profiles (id, display_name, avatar_url)
    values (
      new.id,
      '诗友' || substr(replace(new.id::text, '-', ''), 1, 6),
      coalesce(new.raw_user_meta_data->>'avatar_url', '')
    );
  end;
  return new;
end $$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- #####################################################################
--  2. poems —— 作品本体
--  这是留住用户的核心资产：一次次的查询会过去，作品留下来。
-- #####################################################################
create table public.poems (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text check (char_length(title) <= 60),
  body            text not null check (char_length(body) between 1 and 1000),

  form            text,
  rhyme_book      text not null default 'pingshui',
  mode            text not null default 'both' check (mode in ('gu', 'jin', 'both')),

  origin          text not null default 'original'
    check (origin in ('original', 'transcribed')),
  author_name     text,

  -- 先留着，等 P2 做「公开作品广场」时再放开 RLS；当前一律不可见他人
  visibility      text not null default 'private'
    check (visibility in ('private', 'unlisted', 'public')),
  tags            text[] not null default '{}',

  analysis_count  int not null default 0,
  latest_analysis_id uuid,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_poems_user_recent on public.poems (user_id, updated_at desc);

create trigger trg_poems_updated
  before update on public.poems
  for each row execute function public.set_updated_at();


-- #####################################################################
--  3. analysis_cache —— 结果缓存（服务端专用）
--  input_hash = sha256(normalize(body) + rhyme_book + mode + engine + engine_version)
--  engine_version 必须进 hash，否则改了 prompt / 换了模型，旧答案会继续吐给用户。
--  严格隔离下不设任何客户端策略 → 客户端完全碰不到这张表，
--  别人的原文不可能从这里泄露。
-- #####################################################################
create table public.analysis_cache (
  id              uuid primary key default gen_random_uuid(),
  input_hash      text not null unique,
  input_text      text not null,

  engine          text not null default 'deepseek',
  engine_version  text not null default '1',
  model           text,
  rhyme_book      text,
  mode            text,

  result          jsonb not null,
  summary         jsonb,

  quality         smallint not null default 0,
  hit_count       int not null default 0,
  last_hit_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index idx_cache_lookup on public.analysis_cache (input_hash);


-- #####################################################################
--  4. analyses —— 个人分析流水
--  user_id 可空：留给将来「未登录先分析、登录后认领」。
--  严格隔离下 user_id 为空的行对客户端不可见（策略用 auth.uid() = user_id 判定）。
-- #####################################################################
create table public.analyses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  poem_id         uuid references public.poems(id) on delete cascade,
  cache_id        uuid references public.analysis_cache(id) on delete set null,

  input_text      text not null,
  input_hash      text not null,

  engine          text not null default 'deepseek',
  engine_version  text not null default '1',
  model           text,
  rhyme_book      text,
  mode            text,

  result          jsonb not null,
  summary         jsonb,

  latency_ms      int,
  tokens_in       int not null default 0,
  tokens_out      int not null default 0,
  cost_cents      numeric(10, 4) not null default 0,

  created_at      timestamptz not null default now()
);

create index idx_analyses_user_recent on public.analyses (user_id, created_at desc);
create index idx_analyses_poem        on public.analyses (poem_id, created_at desc);
create index idx_analyses_hash        on public.analyses (input_hash);

-- 每次分析回写作品计数与最近一次结果
create or replace function public.after_analysis_insert()
returns trigger language plpgsql as $$
begin
  if new.poem_id is not null then
    update public.poems
       set analysis_count = analysis_count + 1,
           latest_analysis_id = new.id
     where id = new.poem_id;
  end if;
  return null;
end $$;

create trigger trg_analyses_touch_poem
  after insert on public.analyses
  for each row execute function public.after_analysis_insert();


-- #####################################################################
--  5. api_usage —— 配额与成本流水
--  每一行是一次 /api/analyze。配额判断、成本看板、异常告警都从这里出。
--  actor_key：未登录时用 sha256(ip + ua) 作为匿名配额桶
-- #####################################################################
create table public.api_usage (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  actor_key     text not null,
  endpoint      text not null default '/api/analyze',
  model         text,
  status        text not null default 'ok'
    check (status in ('ok', 'cache_hit', 'timeout', 'error', 'quota_exceeded')),
  tokens_in     int not null default 0,
  tokens_out    int not null default 0,
  cost_cents    numeric(10, 4) not null default 0,
  latency_ms    int,
  created_at    timestamptz not null default now()
);

create index idx_usage_actor_recent on public.api_usage (actor_key, created_at desc);
create index idx_usage_user_recent  on public.api_usage (user_id, created_at desc);

-- 今日配额：按北京时间自然日重置，避免 UTC 在早八点把配额清零
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
          and status in ('ok', 'cache_hit', 'timeout')) as used
  )
  select jsonb_build_object(
           'quota',     quota,
           'used',      used,
           'remaining', greatest(0, quota - used)
         )
  from base;
$$;


-- #####################################################################
--  6. feedback —— 反馈与数据报错
--  status / admin_reply 属运营侧字段，客户端不可写，插入时由触发器强制归零
-- #####################################################################
create table public.feedback (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade,
  kind         text not null default 'bug'
    check (kind in ('bug', 'idea', 'data_error', 'other')),
  content      text not null check (char_length(content) between 1 and 1000),
  contact      text,
  page_url     text,
  app_version  text,
  status       text not null default 'open'
    check (status in ('open', 'triaged', 'resolved', 'wontfix')),
  admin_reply  text,
  created_at   timestamptz not null default now()
);

create index idx_feedback_open on public.feedback (created_at desc) where status = 'open';

create or replace function public.guard_feedback_state()
returns trigger language plpgsql as $$
begin
  if not public.is_privileged() then
    new.status      := 'open';
    new.admin_reply := null;
  end if;
  return new;
end $$;

create trigger trg_feedback_guard
  before insert or update on public.feedback
  for each row execute function public.guard_feedback_state();


-- =====================================================================
--  RLS：全部开启。默认全拒，只放行「自己的数据」
-- =====================================================================
alter table public.profiles       enable row level security;
alter table public.poems          enable row level security;
alter table public.analyses       enable row level security;
alter table public.analysis_cache enable row level security;
alter table public.api_usage      enable row level security;
alter table public.feedback       enable row level security;

-- 列级防护：客户端不许直接改这三个字段
revoke update (plan, daily_quota, role) on public.profiles from anon, authenticated;
revoke update (status, admin_reply)     on public.feedback from anon, authenticated;

-- profiles：仅本人
create policy "本人可读档"  on public.profiles for select using (auth.uid() = id);
create policy "本人可改档"  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- poems：仅本人，增删改查全部锁死
create policy "本人可读" on public.poems for select using (auth.uid() = user_id);
create policy "本人可建" on public.poems for insert with check (auth.uid() = user_id);
create policy "本人可改" on public.poems for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "本人可删" on public.poems for delete using (auth.uid() = user_id);

-- analyses：仅本人
create policy "本人可读" on public.analyses for select using (auth.uid() = user_id);
create policy "本人可建" on public.analyses for insert with check (auth.uid() = user_id);
create policy "本人可改" on public.analyses for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "本人可删" on public.analyses for delete using (auth.uid() = user_id);

-- analysis_cache：刻意不建任何策略 —— 服务端（service_role）专用，客户端一律无权

-- api_usage：本人可读自己的用量；写入只走服务端
create policy "本人可读用量" on public.api_usage for select using (auth.uid() = user_id);

-- feedback：本人可读可提交，看不到别人的反馈
create policy "本人可读反馈" on public.feedback for select using (auth.uid() = user_id);
create policy "可提交反馈"   on public.feedback for insert with check (auth.uid() = user_id);

notify pgrst, 'reload schema';
