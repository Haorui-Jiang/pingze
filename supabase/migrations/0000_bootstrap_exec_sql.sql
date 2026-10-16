-- =====================================================================
--  引导脚本 —— 只需在 Supabase 后台 SQL Editor 里粘贴一次，点 Run
--
--  它只做一件事：创建一个 service_role 专属的 exec_sql 函数。
--  有了它，之后所有建表、改表、灌数据都可以用
--      （工作区助手）python db/sb.py sqlfile migrations/0001_p0_strict.sql
--  全自动跑，不再需要打开后台。
--
--  安全边界：
--    · security definer，只能被 service_role 调用
--    · 已从 public / anon / authenticated 全部 revoke，前端拿不到执行权
--    · 注意：持有 service_role key = 持有本库全权，切勿下发到前端或 Git
-- =====================================================================

create extension if not exists pgcrypto;

create or replace function public.exec_sql(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if trim(query) ~* '^\s*(select|with|values|table|explain)\M' then
    execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query) into result;
    return coalesce(result, '[]'::jsonb);
  else
    execute query;
    return jsonb_build_object('ok', true);
  end if;
exception when others then
  return jsonb_build_object('error', true, 'message', sqlerrm, 'code', sqlstate);
end $$;

revoke all on function public.exec_sql(text) from public;
revoke all on function public.exec_sql(text) from anon;
revoke all on function public.exec_sql(text) from authenticated;
grant execute on function public.exec_sql(text) to service_role;

-- 自检：应返回 [{"ok": true, "answer": 1}]
select public.exec_sql('select 1 as answer');
