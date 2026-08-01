-- Supabaseダッシュボードの SQL Editor で実行してください。
-- words テーブルに、Excel Wrk シートのD列由来の「マーカー」列を追加する。
-- 単一のテキスト値（例: 'tips'）を持ち、複数種のマーカーを今後追加していく想定。
-- anon read-only ポリシー（rls_readonly_update.sql）は列単位ではなくテーブル単位の
-- SELECT許可なので、この列追加に伴うRLS変更は不要。

alter table public.words add column if not exists marker text;
