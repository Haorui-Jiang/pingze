-- =====================================================================
--  限制单用户的查询记录条数（2026-10-20 上线前安全审查 P2-5）
--
--  背景：
--    queries / query_insights 已有**单行**体积上限，但没有**总量**上限：
--      · queries.result 有 queries_result_size_check（64KB）
--      · queries.input_text 有 1..1000 check
--    但行数完全不受约束 —— 任何登录用户都能无限 INSERT。
--
--    线上实测（用临时探测账号）：
--        POST /rest/v1/queries  单次请求塞 200 行 × ~60KB
--        → 201 Created，耗时 7.1s
--        → 库内行数 6 → 206
--    重复几次就能把 Supabase 免费额度（500MB）撑爆，或产生存储账单。
--    服务端唯一的花钱接口 /api/ai-insight 有 IP 限流，但**直连 PostgREST
--    的 INSERT 完全绕过限流**（限流只在 Netlify 函数里）。
--
--  修法：BEFORE INSERT 触发器限制单用户行数。
--    为什么不用 CHECK 约束：PostgreSQL 的 CHECK 里不能含子查询
--    （subqueries are not allowed in CHECK），行数是跨行事实，只能用触发器。
--    为什么不用前端限流：前端和直连 REST 都能被绕过，只有 DB 侧是硬边界。
--
--  阈值取 500 / 1000 的依据（实测当前用量）：
--    · 现有 3 个真实用户各只有 2 条 queries、2~5 条 insights
--    · 前端「查询记录」面板只读最近 20 条（auth.js 的 limit(20)）
--    · 最坏的无脑使用方式（每秒点一次 AI 且每次都自动存），
--      500 条也够用好几个月
--    留这么宽的余量是为了**不误伤正常用户**；防的是脚本批量灌，
--    几百条的差距对攻击者不算障碍，对用户却很有价值。
--
--  超限时的行为：抛 23514（check_violation），前端会看到 PostgREST 的
--    "new row for relation ... violates check constraint" 提示。
--    这是可接受的：真正常见的用户不会撞到，真撞到了说明该清理了。
--    后续若要更好的体验，可以在前端加提示 + 「清理旧记录」入口。
--
--  运行：
--      python db/sb.py sqlfile supabase/migrations/20261020122500_limit_record_rows.sql
--  （本项目迁移的实际应用通道是 exec_sql，supabase db push 不可用）
--
--  自检：
--    -- 上限常量
--    select proname, prosrc from pg_proc where proname like 'enforce_%';
--    -- 构造超限插入 → 应返回 {error:true, code:'23514'}
--    -- 删掉最后一条后再插 → 应恢复成功
-- =====================================================================


-- #####################################################################
-- 1) queries：单用户行数上限
--
--    SECURITY DEFINER 的原因：计数子查询要读 public.queries，
--    在触发器里执行时 current_user 是触发器 owner（postgres），
--    用 definer 才能看到全部行、并避免受调用方 RLS 上下文影响。
--    search_path 锁死 public —— SECURITY DEFINER 函数不锁 search_path
--    是公认的提权面（可被临时 schema 劫持），必须写。
-- #####################################################################
create or replace function public.enforce_queries_row_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap constant int := 500;
  n   int;
begin
  -- ★ 并发留余量：两个并发请求可能同时通过检查，最多超出几条。
  --   这不是漏洞（攻击者要的差几万条），只是让上限不是硬精确值。
  select count(*) into n from public.queries where user_id = new.user_id;
  if n >= cap then
    raise exception
      '查询记录已达上限（% 条），请先删除一些旧记录再保存。', cap
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_queries_row_limit on public.queries;
create trigger trg_queries_row_limit
  before insert on public.queries
  for each row execute function public.enforce_queries_row_limit();


-- #####################################################################
-- 2) query_insights：单用户行数上限
--
--    注意这里也要限：AI 内容每次生成都会新增一行，用户可以反复生成
--    同一条诗的赏析（前端只在「回放态」锁开关，新查询不锁）。
--    上限取 1000（比 queries 宽，因为每条 query 可以对应多种/多条赏析）。
-- #####################################################################
create or replace function public.enforce_query_insights_row_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap constant int := 1000;
  n   int;
begin
  select count(*) into n from public.query_insights where user_id = new.user_id;
  if n >= cap then
    raise exception
      'AI 赏析记录已达上限（% 条），请先删除一些旧记录。', cap
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_query_insights_row_limit on public.query_insights;
create trigger trg_query_insights_row_limit
  before insert on public.query_insights
  for each row execute function public.enforce_query_insights_row_limit();


-- #####################################################################
-- 3) 函数权限：这两个是触发器函数，客户端不需要直接调用
--
--    ★ 又是「必须先撤 PUBLIC」这个坑（迁移 20261016093000 P0-1 的同款）：
--      PostgreSQL 函数默认带 PUBLIC 的 EXECUTE 授权，
--      只 revoke anon/authenticated 是**静默 no-op**。
--      虽然它们是触发器函数、PostgREST 不会暴露无参调用，
--      但一旦将来有任何可传参调用它们的入口，就等于把 SECURITY DEFINER
--      暴露给公网。一并收口。
-- #####################################################################
revoke all on function public.enforce_queries_row_limit()         from public;
revoke all on function public.enforce_queries_row_limit()         from anon, authenticated;
revoke all on function public.enforce_query_insights_row_limit() from public;
revoke all on function public.enforce_query_insights_row_limit() from anon, authenticated;


-- #####################################################################
-- 4) 已知残留（本迁移管不了的）：速率
--
--    行数上限解决的是「总量」，**速率**（每秒插 1 条还是 100 条）没解决。
--    lib/rate-limit.js 是**进程内** IP 计数，Netlify Serverless 多实例下
--    只能压住单实例突发；直连 PostgREST 的 INSERT 也完全绕过它。
--    真要分布式速率限制需要 Redis/Upstash 之类，本项目刻意不引（零依赖原则）。
--    当前的可接受理由：
--      · 单条 64KB + 单用户 500 条 ⇒ 单用户最坏占用约 32MB；
--      · 要灌满 500MB 需要约 16 个账号，而每个账号都要过邮箱验证；
--      · Supabase 自身的流量与请求数限制是最后一道兜底。
--    ⇒ 结论：行数上限 + 邮箱验证门槛，够挡住随手脚本；
--      挡不住有组织的批量刷号，那属于 P2-4（开 CAPTCHA）的范畴。
-- #####################################################################


-- #####################################################################
-- 5) 刷新 PostgREST schema cache
-- #####################################################################
notify pgrst, 'reload schema';
