# Spabase_English（英単語クイズ・Supabase移植テスト）

`英単語`（localStorage+words.json/expressions.json版）を、単語データ・和英表現データの保存先を
**Supabase**（`SpabaseTest`と同じプロジェクト）に置き換えて移植したテストアプリです。
元アプリ（`R:\PUBTEMP\FY26\AI_Experiment\英単語`）はそのまま残しています。

## セットアップ

1. Supabaseダッシュボードの **SQL Editor** で `schema.sql` を実行し、`words` / `expressions` テーブルを作成する。
2. 続けて `seed.sql` を実行すると、元アプリの `words.json`（3000件）をそのままコピーできる（推奨）。
3. `config.js` は `SpabaseTest` と同じプロジェクトの接続情報を設定済み。
4. AI例文機能をローカルサーバー経由で使う場合は、`GEMINI_API_KEY` 環境変数が設定された状態で
   `node server.js`（ポート **10509**）を起動し、`http://localhost:10509` を開く。
   - 環境変数が無い場合や `file://` 直接オープンでも、ホーム画面の「🔑 AI機能のAPIキー設定」で
     Gemini APIキーをこの端末のブラウザに保存すれば、ブラウザから直接Gemini APIを呼び出せる
     （元アプリと同じ二経路方式をそのまま踏襲）。

## 移植スコープ

- 単語クイズ・和英表現練習の両方を移植（出題モード、クイズ進行、○×判定、周回、AI例文リクエストすべて含む）
- クイズ進行中のセッション（中断・再開）は元アプリ同様、端末の`localStorage`に保持（Supabaseには保存しない）
- Excel再取り込みは、パース結果のうち **Supabase上に無い末尾分だけ** を`words`テーブルにinsertする方式
  （既存データの上書き・削除はしない）
- 元アプリにあった「words.json/expressions.jsonエクスポート→git commit」の運用は、Supabaseが
  そのまま永続化するため廃止

## セキュリティ上の注意

GitHub Pages等での公開を前提に、`words`/`expressions`テーブルのRLSはanonキーに対して
**SELECT（読み取り）のみ**を許可しています（`rls_readonly_update.sql`）。
書き込み（単語import・和英表現CRUD）は`SUPABASE_SERVICE_ROLE_KEY`環境変数を持つ
ローカルの`node server.js`のみが代行できます。そのため公開ページ単体（サーバー無し）では
クイズ出題（読み取り）のみ可能で、登録・編集・削除・Excel再取り込みは
`node server.js`をローカルで起動している環境でのみ動作します。
