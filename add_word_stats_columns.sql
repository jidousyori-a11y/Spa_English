-- Supabaseダッシュボードの SQL Editor で実行してください。
-- words テーブルに、単語ごとの出題・誤答の統計を持たせる。
-- 画面表示は今のところ不要（内部データとしてのみ保持）。
--
-- selected_count : テストセット（1回のクイズ開始）に選ばれた回数。
--                  同じテスト内でのやり直し周（2周目以降）では増やさない。
-- tested_count   : 実際に出題・回答された回数。同じテスト内で間違えて
--                  やり直し周に再登場した分も含めて毎回加算する。
-- wrong_count    : 不正解だった累積回数。

alter table public.words add column if not exists selected_count integer not null default 0;
alter table public.words add column if not exists tested_count integer not null default 0;
alter table public.words add column if not exists wrong_count integer not null default 0;

-- 単語1件分の統計をまとめて加算するRPC。read-modify-writeではなく
-- SQLの列同士の演算で行うため、複数端末からの同時アクセスでも欠落しない。
create or replace function public.increment_word_stats(
  p_id bigint,
  p_selected integer default 0,
  p_tested integer default 0,
  p_wrong integer default 0
) returns void
language sql
as $$
  update public.words
  set selected_count = selected_count + p_selected,
      tested_count = tested_count + p_tested,
      wrong_count = wrong_count + p_wrong
  where id = p_id;
$$;
