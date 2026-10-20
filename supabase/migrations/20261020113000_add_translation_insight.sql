-- =====================================================================
--  add_translation_insight · AI 诗词翻译入库（2026-10-20）
--
-- 背景（用户需求）：
--    AI 赏析区新增「诗词翻译」功能（古文原文 → 现代汉语白话），
--    与已有的「平仄分析 / 诗词鉴赏」并列，同一套配额、同一条入库链路。
--
-- 设计取舍：
--   1. **加枚举值，不建新表、不加新列。**
--      迁移 20261016094246 已刻意把 query_insights 设计成 append-only
--      （不给 UPDATE），AI 内容是「查完之后陆续追加」的。
--      若为翻译另建一张表，就得重复一遍 RLS/权限/索引/前端读取归并；
--      若给现有表加 translation 列，则必须放开 UPDATE 才能填值，
--      破坏「记录不可篡改」的既有语义。
--      kind 加一个取值是最省事、且不损伤任何既有性质的方案。
--   2. kind 是 check 约束，PostgreSQL 会自动命名为
--      query_insights_kind_check（表级内联约束的默认名），
--      所以这里 drop + add 重建约束。
--      为防名字对不上（旧库可能是别的名字），drop 前先按 pg_constraint
--      查出真实约束名再删 —— 不要硬编码依赖自动命名。
--   3. 约束重建后必须重新 notify pgrst，否则 PostgREST 的 schema cache
--      里仍是旧约束，报错文案会误导（实际约束已经生效了）。
--   4. 权限不需要动：本迁移不建表、不建函数、不加列，
--      只是约束表达式变宽，对 anon/authenticated 的既有 revoke 无影响。
--
--  ★ 三方契约（改一处必须同步三处，否则静默失效）：
--      后端白名单   lib/ai-insight.js  → TYPES = ['analysis','appreciation','translation']
--      前端入库白名单 结果/auth.js      → onAiDone 的 kind 判断
--      前端中文标签 结果/auth.js        → AI_KIND_LABEL
--      本约束        （即本文件）
--
--  运行：
--      python db/sb.py sqlfile supabase/migrations/<本文件>
--  （本项目迁移的实际应用通道是 exec_sql，supabase db push 不可用）
-- =====================================================================

-- 1) 先找出 kind 上现存的 check 约束真实名字，再删除 ------------------
--    内联 check 的自动名是 query_insights_kind_check，但不同建表方式
--    （后来加约束 / 手工命名）可能不一致，故从系统表查，不硬编码。
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.query_insights'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.query_insights drop constraint %I', c.conname);
    raise notice 'dropped constraint: %', c.conname;
  end loop;
end
$$;

-- 2) 用放宽后的枚举重建（translation = 白话文翻译）----------------------
alter table public.query_insights
  add constraint query_insights_kind_check
  check (kind in ('analysis', 'appreciation', 'translation'));

-- 3) 约束换了名字（同名重建），PostgREST 的 schema cache 必须刷新，
--    否则报错信息仍按旧约束措辞误导排查。
notify pgrst, 'reload schema';