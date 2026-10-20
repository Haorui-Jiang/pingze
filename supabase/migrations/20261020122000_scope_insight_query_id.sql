-- =====================================================================
--  收口 query_insights 的 query_id 归属（2026-10-20 上线前安全审查 P2-1）
--
--  背景：
--    query_insights 的 INSERT 策略只校验 user_id：
--        create policy "本人可建AI赏析" on public.query_insights
--          for insert with check (auth.uid() = user_id);
--    外键 query_id references queries(id) 只保证「这行 query 存在」，
--    **不保证「它属于我」**。于是任何登录用户可以把自己的内容挂到
--    别人的 query 上。
--
--    线上实测（用临时探测账号 + 一条真实存在的他人 query_id）：
--        POST /rest/v1/query_insights
--        {"user_id": <自己>, "query_id": <他人的真实 query_id>,
--         "kind": "analysis", "content": "..."}
--        → 201 Created        ★ 成功
--
--  实际危害（诚实评估）：
--    目前**不构成数据泄露** —— SELECT 策略是 auth.uid() = user_id，
--    所以受害者自己看不到被挂上去的内容，攻击者也只在回放自己记录时
--    能读到（loadInsightsFor 的 ids 来自自己的记录列表）。
--    但它是「数据完整性缺口」：
--      ① 受害者删掉那条 query 时 on delete cascade 会连带删掉别人的数据；
--      ② 将来只要给 query_insights 加 UPDATE 策略、或前端改成按 query_id
--         读取而不按 user_id 过滤，这就是一条现成的污染/篡改通道。
--    修复成本极低，没有理由不修。
--
--  修法：把 with check 收紧为「user_id 是我 **且** query_id 那行也是我的」。
--  必须 drop 旧策略再建 —— PostgreSQL 的 CREATE POLICY IF NOT EXISTS 不存在，
--  同名策略只能先删后建。
--
--  运行：
--      python db/sb.py sqlfile supabase/migrations/20261020122000_scope_insight_query_id.sql
--  （本项目迁移的实际应用通道是 exec_sql，supabase db push 不可用）
--
--  自检（应用后跑，全部应返回期望值）：
--    -- 策略已换成带 exists 的版本
--    select policyname, cmd, with_check from pg_policies
--     where tablename = 'query_insights' and cmd = 'INSERT';
--    -- 期望：with_check 里同时含 auth.uid() = user_id 与 exists (... queries ...)
--
--    -- 端到端验收（需真实登录态，审查时已实测过修复前 = 201）：
--    --   拿别人的 query_id 插入 → 应 403
--    --   new row violates row-level security policy for table "query_insights"
--    -- 拿自己的 query_id 插入 → 应 201
-- =====================================================================


-- #####################################################################
-- 1) 收紧 INSERT 策略：user_id 与 query_id 双重归属校验
--
--    为什么用 exists 子查询而不是给 queries 加复合外键：
--    queries 表当前没有 (id, user_id) 唯一约束可作复合外键目标，
--    加唯一约束会改变主键语义；而 RLS 策略里查一次索引命中，成本 O(1)，
--    与现有「本人可建查询记录」策略同一量级，不需要额外结构改动。
-- #####################################################################
drop policy if exists "本人可建AI赏析" on public.query_insights;

create policy "本人可建AI赏析" on public.query_insights
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.queries q
       where q.id = query_id
         and q.user_id = auth.uid()
    )
  );


-- #####################################################################
-- 2) 提醒：这一条依赖「queries 表的 user_id 列不被客户端伪造」。
--    该列由 queries 的 INSERT 策略 with check (auth.uid() = user_id) 保证
--    （迁移 0007 第 3 节），已实测伪造 user_id 会 403。
--    也就是说：「能进这条 exists 的 query 一定是自己的」这条链是完整的。
-- #####################################################################


-- #####################################################################
-- 3) 刷新 PostgREST schema cache（策略变了要刷）
-- #####################################################################
notify pgrst, 'reload schema';
