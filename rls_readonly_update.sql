-- anonキーをGitHub Pages等の公開環境に置く前提で、匿名ロールの権限を読み取り専用に絞る。
-- 書き込み(insert/update/delete)は、service_roleキーを持つローカルサーバー経由でのみ行う。
-- (SpabaseTest/itemsテーブルは廃止済み。drop_items_table.sql を先に実行しておくこと)
-- Supabaseダッシュボード > SQL Editor で実行してください。

drop policy if exists "allow all for anon (test app)" on public.words;
drop policy if exists "allow all for anon (test app)" on public.expressions;

create policy "anon read-only"
  on public.words
  for select
  to anon
  using (true);

create policy "anon read-only"
  on public.expressions
  for select
  to anon
  using (true);

-- service_roleはRLSを常にバイパスするため、書き込み用のポリシーは不要。
