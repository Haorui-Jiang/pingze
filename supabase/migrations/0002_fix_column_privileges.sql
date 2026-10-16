-- =====================================================================
--  0002 · 修正 0001 里失效的列级隔离 + 收紧 anon 角色
--
--  背景（重要教训，别再踩）：
--    0001 里写的是
--        revoke update (plan, daily_quota, role) on public.profiles from anon, authenticated;
--    这条语句执行成功了，但【完全没生效】。
--    原因： Supabase 通过 ALTER DEFAULT PRIVILEGES 授予的是【表级】权限
--    （relacl 串里显示为 authenticated=arwdDxtm/postgres，w 即 UPDATE）。
--    PostgreSQL 的语义是，列级 REVOKE 只能撤销当初【按列】授予的权限；
--    当初是表级授予时它是个 no-op，还不报错、静默通过。
--    验证手段：看 pg_class.relacl，以及 information_schema.column_privileges
--    是否仍列出该列的 UPDATE —— 如果还在，就说明没挡住。
--
--  正确写法：先把整表的 UPDATE/INSERT 从 authenticated 收回来，
--           再【按列】授予允许用户改的那几个字段。顺序不能反。
--
--  另一处加固：anon 角色对这 6 张表的一切权限全部收回。
--  前端 Supabase JS 用的是「anon key 作 apikey + 用户 JWT 作 bearer」，
--  PostgREST 会按 JWT 把角色解析成 authenticated，不会落到 anon；
--  真正的 anon 请求 = 未登录，严格隔离下应当什么也做不了。
--
--  运行（工作区助手）：python db/sb.py sqlfile migrations/0002_fix_column_privileges.sql
-- =====================================================================

-- 1. anon 一律无权（未登录不得触碰任何 P0 数据）
revoke all on public.profiles       from anon;
revoke all on public.poems          from anon;
revoke all on public.analyses       from anon;
revoke all on public.analysis_cache from anon;
revoke all on public.api_usage      from anon;
revoke all on public.feedback       from anon;

-- 2. profiles：收回整表 UPDATE，只放行真正属于个人资料的列
revoke update on public.profiles from authenticated;
grant  update (display_name, avatar_url, bio, default_rhyme_book, default_mode)
  on public.profiles to authenticated;

-- profiles 没有任何 INSERT 策略（建档只走 handle_new_user 的 security definer，
-- 绕过 RLS，不需要这条授权）。索性把 INSERT 也收回来，
-- 免得将来有人补策略时被顺手利用：新用户自带 role=admin 注册进来。
revoke insert on public.profiles from authenticated;

-- 3. feedback：收回整表 INSERT/UPDATE。
--    运营字段 status / admin_reply 一律不在授予清单里，
--    客户端连 INSERT 都塞不进来 001 里那个触发器之外的第二条防线。
revoke insert on public.feedback from authenticated;
revoke update on public.feedback from authenticated;
grant  insert (id, user_id, kind, content, contact, page_url, app_version)
  on public.feedback to authenticated;

-- 4. api_usage：本就只有 select policy，这里顺手把写权限也收回来，
--    确保它只能由服务端（service_role）写入
revoke insert, update, delete on public.api_usage from authenticated;

-- 5. 提醒自己：这几行只对现有表生效。
--    将来新建的表仍会被 Supabase 的默认权限自动授予 anon / authenticated，
--    需要一并把建表脚本里的 revoke 补上，或者改 ALTER DEFAULT PRIVILEGES。

notify pgrst, 'reload schema';
