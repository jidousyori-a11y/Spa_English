-- Supabaseダッシュボードの SQL Editor で実行してください。
-- words テーブルに、AIリクエストで得た補足情報をユーザーが選んで保存するための列を追加する。
-- anon read-only ポリシーはテーブル単位のSELECT許可なので、この列追加に伴うRLS変更は不要。
-- 書き込みは既存の書き込み経路（server.jsのservice_roleキー経由）と同じ。

alter table public.words add column if not exists ai_note text;
