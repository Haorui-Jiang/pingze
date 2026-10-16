-- =====================================================================
--  add_query_insights · AI 赏析结果入库（2026-10-16）
--
-- 背景（用户需求 2）：
--    V5 的 queries 表只存「查表输入 + 查表结果」，迁移 0007 明确写了
--    「不存任何 AI 生成内容」。现在要让 AI 平仄分析 / 诗词鉴赏的输出
--    也能保存下来，并在「查询记录」里显示、回放。
--
-- 设计取舍：
--   1. 另开一张 append-only 表，而不是给 queries 加列。
--      queries 的 RLS 刻意不给 UPDATE（记录不可篡改，只能删）；
--      AI 结果是「查完之后陆续追加」的内容，若塞进 queries 就必须
--      放开 UPDATE，破坏既有语义。独立表沿用同样的只增/只删口径。
--   2. kind 用 check 约束锁死两个取值（analysis / appreciation），
--      与后端 lib/ai-insight.js 的 TYPES 白名单一一对应。
--   3. 外键 query_id → queries(id) on delete cascade：
--      删掉查询记录时 AI 内容自动跟着消失，不留孤儿。
--   4. 同一个查询的同一个 kind 可以有多条（用户重复生成）。
--      前端取 created_at 最新的一条展示，历史保留。
--   5. content 限长 8000 字：与提示词 400 字上限留足余量，
--      同时防止异常大文本把库撑爆。
--
--  运行：
--      python db/sb.py sqlfile supabase/migrations/<本文件>
--  （本项目迁移的实际应用通道是 exec_sql，supabase db push 不可用）
-- =====================================================================

-- 1) AI 赏析内容表 --------------------------------------------------------
create table if not exists public.query_insights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id)   on delete cascade,
  query_id    uuid not null references public.queries(id) on delete cascade,
  kind        text not null check (kind in ('analysis', 'appreciation')),
  content     text not null check (char_length(content) between 1 and 8000),
  model       text,
  created_at  timestamptz not null default now()
);

-- 列表按用户 + 时间倒序读
create index if not exists idx_query_insights_user_recent
  on public.query_insights (user_id, created_at desc);
-- 回放某条查询时取各 kind 的最新一条
create index if not exists idx_query_insights_query_kind
  on public.query_insights (query_id, kind, created_at desc);

-- 2) RLS：与 queries 完全同口径（本人可读 / 可建 / 可删，无 UPDATE）-----
alter table public.query_insights enable row level security;

drop policy if exists "本人可读AI赏析" on public.query_insights;
create policy "本人可读AI赏析" on public.query_insights
  for select using (auth.uid() = user_id);

drop policy if exists "本人可建AI赏析" on public.query_insights;
create policy "本人可建AI赏析" on public.query_insights
  for insert with check (auth.uid() = user_id);

drop policy if exists "本人可删AI赏析" on public.query_insights;
create policy "本人可删AI赏析" on public.query_insights
  for delete using (auth.uid() = user_id);

-- anon 一律摸不到；authenticated 不给 UPDATE（append-only）
revoke all    on public.query_insights from anon;
revoke update on public.query_insights from authenticated;

-- 3) 刷新 PostgREST schema cache -----------------------------------------
notify pgrst, 'reload schema';