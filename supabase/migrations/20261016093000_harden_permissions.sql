-- =====================================================================
--  权限收口 · 上线前安全审查 P0-1 / P1-2 / P1-3
--
--  背景（2026-10-16 上线前安全审查，报告见 research/上线前安全审查报告-20261016.md）：
--  审查用「前端 anon key」（设计内公开的凭据）打 /rest/v1/rpc/，实测发现：
--
--  1) 【P0】public.ai_quota_consume 匿名者可调用。
--     实测：has_function_privilege('anon', ..., 'execute') = true，
--     且能真正扣减任意 user_id 的当日 AI 配额。
--     根因：迁移 0007 只写了
--         revoke execute on function ai_quota_consume(uuid) from anon, authenticated;
--     但 PostgreSQL 函数默认带一条 PUBLIC 的 EXECUTE 授权，
--     **只撤具体角色撤不掉 PUBLIC 继承的那一份**（静默 no-op）。
--     线上 proacl 实测为 {=X/postgres, postgres=X, service_role=X}，
--     开头的 "=X" 就是 PUBLIC —— anon/authenticated 是通过它继承到权限的。
--     对比 exec_sql 的 proacl 没有 "=X"，因为 0000 正确写了
--         revoke all on function exec_sql(text) from public;
--     **同一个坑，0000 躲过了、0007 没躲过。**
--
--     正确写法：必须先 revoke ... from public，再撤具体角色。
--
--  2) 【P1】is_privileged / jwt_role / handle_new_user / guard_membership_columns
--     同样是 PUBLIC 可执行。其中 handle_new_user 与 guard_membership_columns
--     是 SECURITY DEFINER（触发器函数）。PostgREST 不暴露触发器函数调用，
--     故当前不可直接利用，但一旦将来有任何可传参调用它们的入口，
--     就等于把 SECURITY DEFINER 暴露给公网。一并收口。
--
--  3) 【P1】ai_usage_today 的 proacl 有 "=X"（PUBLIC），
--     它本身只读 auth.uid() 自己的数据、风险低，但同样收口为 authenticated only。
--
--  4) 【P1】三张表对 authenticated 残留 TRUNCATE / REFERENCES / TRIGGER 表级权限。
--     TRUNCATE **不受 RLS 保护**，是一条绕过全部策略的物理清空路径。
--     PostgREST 只暴露 GET/POST/PATCH/DELETE，当前打不到（属潜在风险而非活漏洞），
--     但任何一个能拼 SQL 的新入口都会变成「一键清库」。收掉。
--     profiles 上的 DELETE 同理：RLS 里没有 DELETE 策略，授权本身无意义。
--
--  5) 【P1】pg_default_acl 实测：public schema 表级默认权限为
--         postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm
--     也就是 **今后在 public 下新建的每一张表，anon/authenticated 自动获得全套权限**
--     （含 TRUNCATE / REFERENCES / TRIGGER）。项目 0002 的注释早就警告过这点，
--     但一直没改根 —— 下次加表忘写 revoke 就会重犯。
--
--  ⚠ 注意本迁移第 6 节的副作用（务必读完再执行）：
--     改完 ALTER DEFAULT PRIVILEGES 后，**新建表不再自动带权限**，
--     必须在建表脚本里显式 grant 客户端真正需要的列/表权限。
--     现有三张表的权限在第 5 节已显式处理完毕，不受影响。
--     服务端一律走 service_role（绕过 RLS），不受影响。
--
--  运行：
--      python db/sb.py sqlfile supabase/migrations/20261016093000_harden_permissions.sql
--  （本项目迁移的实际应用通道是 exec_sql，supabase db push 不可用）
-- =====================================================================


-- #####################################################################
--  1) 函数权限：先撤 PUBLIC，再按需显式授予
--     ★ 铁律：撤 PUBLIC 与撤具体角色是两件事，必须都写。
-- #####################################################################

-- 1.1 AI 配额扣减：仅 service_role（后端用 service_role 调）
revoke all on function public.ai_quota_consume(uuid) from public;
revoke all on function public.ai_quota_consume(uuid) from anon, authenticated;
grant  execute on function public.ai_quota_consume(uuid) to service_role;

-- 1.2 辅助 / SECURITY DEFINER 函数：全部只留给 owner 与 service_role。
--     这些函数没有任何客户端直连需求（handle_new_user 与
--     guard_membership_columns 是触发器函数，只能由触发器调用）。
revoke all on function public.is_privileged()            from public;
revoke all on function public.is_privileged()            from anon, authenticated;
revoke all on function public.jwt_role()                  from public;
revoke all on function public.jwt_role()                  from anon, authenticated;
revoke all on function public.handle_new_user()           from public;
revoke all on function public.handle_new_user()           from anon, authenticated;
revoke all on function public.guard_membership_columns()  from public;
revoke all on function public.guard_membership_columns()  from anon, authenticated;

-- 1.3 配额只读查询：登录用户可自查剩余次数（读 auth.uid() 自己的行）
revoke all on function public.ai_usage_today()            from public;
revoke all on function public.ai_usage_today()            from anon;
grant  execute on function public.ai_usage_today()        to authenticated, service_role;


-- #####################################################################
--  2) 表级权限收口：去掉绕过 RLS 的 TRUNCATE 与无用的 DELETE / REFERENCES / TRIGGER
-- #####################################################################

-- 2.1 三张表：TRUNCATE / REFERENCES / TRIGGER 一律收回。
--     anon 本来就 revoke all 过，这里再写一遍是为了「迁移即文档」，
--     且防止将来有人手滑把 anon 的授权加回来。
revoke truncate, references, trigger
  on public.profiles, public.queries, public.query_insights
  from anon, authenticated;

-- 2.2 profiles：RLS 里没有 DELETE 策略，授权无意义；且将来若补 DELETE 策略，
--     记得同时确认这一条是不是要保留（用户自删档位目前无业务需求）。
revoke delete on public.profiles from authenticated;

-- 2.3 显式确认三张表的「客户端最小权限」仍然成立（幂等，便于对账）。
--     queries / query_insights：本人可读 / 可建 / 可删，**不给 UPDATE**（append-only）。
--     profiles：只给 SELECT（本人），不给 INSERT / UPDATE。
grant select on public.profiles     to authenticated;
grant select, insert, delete
  on public.queries, public.query_insights to authenticated;


-- #####################################################################
--  3) 删掉已失效的策略
--
--     profiles 上还有一条 UPDATE 策略「本人可改档」（迁移 0001 建）。
--     但 0006 已经把 profiles 的表级 UPDATE 完全收回
--     （has_table_privilege('authenticated','public.profiles','UPDATE') = false），
--     这条策略永远不可能生效 —— 留着只会让后人误以为
--     「用户可以改自己的档案」，进而在此基础上加错逻辑。删掉。
-- #####################################################################
drop policy if exists "本人可改档" on public.profiles;


-- #####################################################################
--  4) sequences：新建序列不再自动给 anon / authenticated 权限
-- #####################################################################
alter default privileges in schema public revoke all on sequences from anon, authenticated;


-- #####################################################################
--  5) ALTER DEFAULT PRIVILEGES：从根上掐掉「新建表自动全套权限」
--
--  ★ 副作用（必须知道）：改完之后，在 public 下新建的表**不再自动**
--    携带 anon / authenticated 权限。建表脚本必须显式 grant。
--    这正是我们要的默认安全：忘写 revoke 的后果，从「全库可写」
--    降级为「客户端读不到数据」（报错可见、可修），而不是静默敞开。
--
--    服务端一律走 service_role（绕过 RLS），完全不受影响。
-- #####################################################################
alter default privileges in schema public revoke all on tables  from anon, authenticated;
alter default privileges in schema public revoke all on functions from public;


-- #####################################################################
--  6) 约束加固：queries.result 是 jsonb 且原本**没有任何大小限制**
--     （input_text 有 1–1000 的 check，query_insights.content 有 1–8000），
--     登录用户可无限往里塞大对象。加一个体积上限防存储被撑爆。
--     64 KB 远超正常查表结果（几十到几百字），不会误伤正常用户。
-- #####################################################################
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'queries_result_size_check'
       and conrelid = 'public.queries'::regclass
  ) then
    alter table public.queries
      add constraint queries_result_size_check
      check (pg_column_size(result) < 65536);
  end if;
end $$;


-- #####################################################################
--  7) 刷新 PostgREST schema cache（函数签名变了必须刷）
-- #####################################################################
notify pgrst, 'reload schema';


-- #####################################################################
--  8) 已知残留：本迁移无法收口的 default ACL（请勿误以为已彻底解决）
--
--  `pg_default_acl` 实测有两组默认权限：
--     role=postgres       → 本迁移第 4/5 节已收口（anon/authenticated 已移除）
--     role=supabase_admin → **收不了**。实测执行
--         alter default privileges for role supabase_admin in schema public
--           revoke all on tables from anon, authenticated;
--     返回 `42501 permission denied to change default privileges`
--     ——该角色由 Supabase 平台持有，改它的默认权限需要 superuser，
--     exec_sql（security definer，owner 为 postgres）做不到。
--
--  实际影响评估：
--     · 本项目所有表都是通过 exec_sql（postgres 身份）建的，
--       走的是 postgres 那组默认权限 → **已被本迁移收口**。
--     · supabase_admin 那组只在「用别的身份建表」时生效，例如
--       在 Dashboard 的 SQL Editor 里直接 CREATE TABLE。
--       若那样建表，新表仍会自带 anon/authenticated 全套权限。
--
--  ⇒ 因此新增一条硬要求：
--     **今后任何新表，不管用什么身份创建，都必须在同一份迁移里显式写全 revoke，**
--     并把它加进 tools/selfcheck.js 的巡检项。别依赖默认权限已经安全。
--
--  （若将来在 Dashboard 手工建表后忘记收权，最直接的症状就是
--    anon key 能读/写那张新表 —— 用 anon key 打 /rest/v1/<新表> 即可自查。）
-- #####################################################################


-- #####################################################################
--  自检（应用后跑这几条，全部应返回期望值）
--
--  期望 has_function_privilege 全 = false（这是权威判断，不要用 proacl 字符串匹配，
--  因为 "postgres=X/postgres" 里含有 "=X" 子串，会误判成还有 PUBLIC）：
--    select has_function_privilege('anon',        'public.ai_quota_consume(uuid)', 'execute');  -- false
--    select has_function_privilege('authenticated','public.ai_quota_consume(uuid)', 'execute');  -- false
--    select has_function_privilege('anon',        'public.exec_sql(text)',         'execute');  -- false
--    select has_function_privilege('anon',        'public.handle_new_user()',      'execute');  -- false
--
--  期望 has_table_privilege 全 = false：
--    select has_table_privilege('authenticated','public.profiles','TRUNCATE');      -- false
--    select has_table_privilege('authenticated','public.profiles','DELETE');         -- false
--    select has_table_privilege('authenticated','public.queries','TRUNCATE');        -- false
--    select has_table_privilege('authenticated','public.query_insights','TRUNCATE'); -- false
--
--  期望仍为 true（不能误伤正常功能）：
--    select has_function_privilege('service_role', 'public.ai_quota_consume(uuid)', 'execute');  -- true
--    select has_function_privilege('authenticated','public.ai_usage_today()',       'execute');  -- true
--    select has_table_privilege('authenticated', 'public.queries', 'SELECT');                    -- true
--    select has_table_privilege('authenticated', 'public.queries', 'INSERT');                    -- true
--    select has_table_privilege('authenticated', 'public.profiles', 'SELECT');                   -- true
-- #####################################################################
