-- Supabaseダッシュボードの SQL Editor で実行してください。
-- クイズの進行状態(session)をDBにミラーリングするテーブル。
-- これまでlocalStorageのみに保存していたため、途中まで進めたクイズは同じ
-- ブラウザ・同じ端末でしか続きができなかった。このテーブルに複製することで、
-- 「PCで3問やって中断し、続きをiPhoneからLAN越しに行う」といったクロスデバイスでの
-- 再開ができるようにする。
--
-- session_key: セッションの種類ごとに1行。'main'=英単語クイズ、'waei'=和英表現練習。
-- data: セッションオブジェクトそのもの(JSON)。クリア済み(進行中のクイズが無い)状態はnull。
-- updated_at: 突き合わせ用。実際の新旧判定はdata内のclient発行のsavedAt(ミリ秒)を
--   優先するが、data内にsavedAtが無い場合のフォールバックとして使う。
--
-- 読み取り専用anon + service_role書き込みの既存パターン(latest_clears等)をそのまま踏襲する。

create table if not exists public.quiz_sessions (
  session_key text primary key,
  data jsonb,
  updated_at timestamptz not null default now()
);

alter table public.quiz_sessions enable row level security;

create policy "anon read-only"
  on public.quiz_sessions
  for select
  to anon
  using (true);
