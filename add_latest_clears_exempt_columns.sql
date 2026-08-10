-- Supabaseダッシュボードの SQL Editor で実行してください。
-- 「今日は免除にする」機能用。免除の日はexempted=trueで記録し、
-- 連続日数の計算上はクリアした日と同様に「途切れていない日」として扱う。
-- reasonは免除理由の任意メモ(未入力ならnull)。

alter table public.latest_clears
  add column if not exists exempted boolean not null default false,
  add column if not exists reason text;
