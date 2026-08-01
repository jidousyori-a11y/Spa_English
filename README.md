# Spabase_English（英単語クイズ・Supabase移植テスト）

`英単語`（localStorage+words.json/expressions.json版）を、単語データ・和英表現データの保存先を
**Supabase**（`SpabaseTest`と同じプロジェクト）に置き換えて移植したテストアプリです。
元アプリ（`R:\PUBTEMP\FY26\AI_Experiment\英単語`）はそのまま残しています。

## セットアップ

1. Supabaseダッシュボードの **SQL Editor** で `schema.sql` を実行し、`words` / `expressions` テーブルを作成する。
2. 続けて `seed.sql` を実行すると、単語データ（12,539件）を投入できる（推奨）。
   `$$SelfEnglish_v1.0.xlsm`（`Wrk`シート）が単語データの一次ソースで、以下の条件でフィルタ済み：
   - 英語（English列）が5単語以上の長文は除外
   - 日本語訳が空欄または「-」等の意味のない表示のものは除外
   - A列に「疑惑」「●」のフラグが付いている行は除外
   以後の追加分は `~/.claude/skills/english_spabase_update` スキルで同じフィルタを適用し、
   Supabase上の現在の最大No.より大きい行だけを差分insertして`words`テーブルにappendする。
3. 既に運用中のSupabaseプロジェクトに対しては、`add_marker_column.sql` を実行して
   `words.marker`列（Excel D列由来、`t`=tips等のマーカー用）を追加する。
   新規セットアップの場合は`schema.sql`に既に含まれているため不要。
4. `config.js` は `SpabaseTest` と同じプロジェクトの接続情報を設定済み。
5. AI例文機能をローカルサーバー経由で使う場合は、`GEMINI_API_KEY` 環境変数が設定された状態で
   `node server.js`（ポート **10509**）を起動し、`http://localhost:10509` を開く。
   - 環境変数が無い場合や `file://` 直接オープンでも、ホーム画面の「🔑 AI機能のAPIキー設定」で
     Gemini APIキーをこの端末のブラウザに保存すれば、ブラウザから直接Gemini APIを呼び出せる
     （元アプリと同じ二経路方式をそのまま踏襲）。

## 移植スコープ

- 単語クイズ・和英表現練習の両方を移植（出題モード、クイズ進行、○×判定、周回、AI例文リクエストすべて含む）
- クイズ進行中のセッション（中断・再開）は元アプリ同様、端末の`localStorage`に保持（Supabaseには保存しない）
- ブラウザ上のExcel再取り込み機能（`server.js`経由）も、パース結果のうち **Supabase上に無い末尾分だけ**
  を`words`テーブルにinsertする方式（既存データの上書き・削除はしない）。定期的な一括追加は
  `~/.claude/skills/english_spabase_update` スキル（同じ差分ロジック）を使う運用に切り替えた
- 元アプリにあった「words.json/expressions.jsonエクスポート→git commit」の運用は、Supabaseが
  そのまま永続化するため廃止

## マーカー付きクイズモード（2026-08-01〜）

`words.marker`列（Excel `Wrk`シートD列由来）に値が入っている単語だけを対象にした
クイズモードをホーム画面に動的表示する（`app.js`の`renderMarkerButtons`）。
現在は`t`（Tips）のみだが、今後複数種のマーカーに拡充していく想定で、
新しいマーカー値が`words`テーブルに現れれば自動的にボタンが増える
（表示名を付けたい場合は`app.js`の`MARKER_LABELS`に追記、未登録なら値をそのまま表示）。

マーカーは`~/.claude/skills/english_spabase_update`スキルで、既存の単語に対しても
Excel側の値をSupabaseへ同期できる（新規単語の差分追加とは別に、既存行のマーカー変更も
検知してUPDATEする）。ただしフィルタで元々除外され未インポートの単語にマーカーを
付けても自動では追加されない。

## セキュリティ上の注意

GitHub Pages等での公開を前提に、`words`/`expressions`テーブルのRLSはanonキーに対して
**SELECT（読み取り）のみ**を許可しています（`rls_readonly_update.sql`）。
書き込み（単語import・和英表現CRUD）は`SUPABASE_SERVICE_ROLE_KEY`環境変数を持つ
ローカルの`node server.js`のみが代行できます。そのため公開ページ単体（サーバー無し）では
クイズ出題（読み取り）のみ可能で、登録・編集・削除・Excel再取り込みは
`node server.js`をローカルで起動している環境でのみ動作します。
