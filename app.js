import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const LS_SESSION = 'eiwq.session.v1';
const LS_CUSTOM = 'eiwq.custom.v1';
const LS_LAST_MODE = 'eiwq.lastMode.v1'; // 「前回と同じテスト」用。直近に開始したモード文字列を保持する（セッション自体が終了・消去された後も残す）。
const LS_GEMINI_KEY = 'eiwq.geminiKey.v1';
const LS_IMPORT_META = 'eiwq.importMeta.v1'; // 表示用のみ。データ本体はSupabase側が正。
const LS_WAEI_SESSION = 'waei.session.v1';
const SHEET_NAME = 'Wrk';
const QUIZ_SIZE = 15;
const GEMINI_MODEL = 'gemini-2.5-flash';

const $ = (id) => document.getElementById(id);

const screens = {
  home: $('home'),
  quiz: $('quiz'),
  result: $('result'),
  waeiHome: $('waeiHome'),
  waeiForm: $('waeiForm'),
  waeiQuiz: $('waeiQuiz'),
  waeiResult: $('waeiResult'),
  notes: $('notes'),
  wordsRegister: $('wordsRegister'),
  wordsTableView: $('wordsTableView'),
  wordEditView: $('wordEditView'),
};

// 初期表示は home（静的HTML側でhiddenなし）だが、ここでは「ユーザーが明示的に
// 画面遷移したか」を追跡するためだけに使う（下記init()参照）。
let currentScreenName = null;

function showScreen(name) {
  currentScreenName = name;
  for (const k of Object.keys(screens)) {
    screens[k].hidden = (k !== name);
  }
}

// ---------- Supabaseデータ（words / expressions） ----------

let words = [];
let expressions = [];
let notes = [];
let editingNoteId = null;

// 現在の画面に表示中のAI補足（保存対象）。「補足を保存する」ボタンが参照する。
let lastAiNoteWordId = null;
let lastAiNoteText = null;

// PostgRESTはデフォルトで1リクエストあたり最大1000件しか返さないため、
// rangeで全件取得できるまでページングする。
async function fetchAllRows(table, orderCol) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select('*')
      .order(orderCol, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function refreshWords() {
  words = await fetchAllRows('words', 'id');
}
async function refreshExpressions() {
  expressions = await fetchAllRows('expressions', 'created_at');
}
async function refreshNotes() {
  try {
    const res = await fetch('notes.json', { cache: 'no-store' });
    if (!res.ok) { notes = []; return; }
    const data = await res.json();
    notes = Array.isArray(data.notes) ? data.notes : [];
  } catch {
    notes = [];
  }
}

function renderStatusBar(state, msg) {
  const el = $('sbStatus');
  if (state === 'unconfigured') {
    el.innerHTML = `<span class="dot warn"></span><span>config.js に SUPABASE_URL / SUPABASE_ANON_KEY を設定してください</span>`;
  } else if (state === 'ok') {
    el.innerHTML = `<span class="dot ok"></span><span>Supabase接続中・単語 ${words.length.toLocaleString()} 件／和英表現 ${expressions.length} 件</span>`;
  } else if (state === 'error') {
    el.innerHTML = `<span class="dot off"></span><span>接続エラー: ${escapeHtml(msg || '')}</span>`;
  } else {
    el.innerHTML = `<span class="dot off"></span><span>読み込み中…</span>`;
  }
}

function loadImportMeta() {
  try { return JSON.parse(localStorage.getItem(LS_IMPORT_META)) || null; }
  catch { return null; }
}
function saveImportMeta(m) { localStorage.setItem(LS_IMPORT_META, JSON.stringify(m)); }

// ---------- localStorage helpers（クイズ進行セッションのみ。端末ローカルの一時状態） ----------

function loadSession() {
  try {
    const s = localStorage.getItem(LS_SESSION);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
function saveSession(s) { localStorage.setItem(LS_SESSION, JSON.stringify(s)); }
function clearSession() { localStorage.removeItem(LS_SESSION); }

// 「前回と同じテスト」ボタン用。セッションが完了・消去された後も、直近に選ばれた
// モードだけは覚えておく。
function loadLastMode() {
  try { return localStorage.getItem(LS_LAST_MODE) || null; } catch { return null; }
}
function saveLastMode(mode) { localStorage.setItem(LS_LAST_MODE, mode); }

// 専用の記録(LS_LAST_MODE)がまだ無い場合でも、既存のセッション（この機能の追加より前に
// 開始したものを含む）にmodeが残っていればそれを使う（機能追加直後でも、新規にテストを
// 始め直さずに「前回と同じテスト」が使えるようにするため）。表示側(renderHome)・実行側
// (クリックハンドラ)の両方から呼ぶので、判定がズレないようここに一本化する。
// セッションのmodeを頼りにした場合は、その場でLS_LAST_MODEへ書き戻しておく。そうしないと、
// 「前回の続きから」で再開しただけ（saveLastModeを呼ばない）のセッションを後で完全クリアして
// ホームへ戻った時、セッション自体が消えて手がかりを失ってしまう。
function getEffectiveLastMode() {
  const session = loadSession();
  const stored = loadLastMode();
  if (stored) return stored;
  if (session && session.mode) {
    saveLastMode(session.mode);
    return session.mode;
  }
  return null;
}

function loadCustomSettings() {
  try { return JSON.parse(localStorage.getItem(LS_CUSTOM)) || { x: 15, y: 5000 }; }
  catch { return { x: 15, y: 5000 }; }
}
function saveCustomSettings(x, y) { localStorage.setItem(LS_CUSTOM, JSON.stringify({ x, y })); }

// ---------- Latest単語モードの連続達成記録 ----------
// Supabase側の latest_clears テーブルで管理する（複数ブラウザ・端末をまたいで
// 集計するため。localStorageは使わない）。読み取りはanonキーで直接、書き込みは
// 他の書き込み系と同様ローカルサーバー経由のみ。

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDaysStr(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return toDateStr(d);
}

let latestClearDates = []; // 新しい順配列 [{date:'YYYY-MM-DD', exempted:boolean}]

async function refreshLatestClears() {
  const { data, error } = await sb
    .from('latest_clears')
    .select('cleared_date, exempted')
    .order('cleared_date', { ascending: false })
    .limit(1000);
  if (error) throw error;
  latestClearDates = (data || []).map(r => ({ date: r.cleared_date, exempted: !!r.exempted }));
}

// 新しい順の配列から、直近の日を起点にした連続達成日数を求める。
// 免除の日もクリアと同様に「途切れていない日」として扱う。
function computeLatestStreak(datesDesc) {
  if (!datesDesc.length) return { lastDate: null, lastExempted: false, streak: 0 };
  let streak = 1;
  for (let i = 1; i < datesDesc.length; i++) {
    if (datesDesc[i].date === addDaysStr(datesDesc[i - 1].date, -1)) streak++;
    else break;
  }
  return { lastDate: datesDesc[0].date, lastExempted: datesDesc[0].exempted, streak };
}

// 連続達成日数の対象となるセッションかどうかを判定する。
// - 上部4モード（Latest単語／完全ランダム／下から300／下から100）は常に対象
// - 一番下のカスタム設定テストは、出題数が15問以上の場合のみ対象
function isStreakEligible(session) {
  if (['latest50', 'all', 'bottom300', 'bottom100'].includes(session.mode)) return true;
  if (session.mode === 'custom' && session.words.length >= 15) return true;
  return false;
}

// 対象セッションが全問正解でクリアされた時点で呼ぶ。同じ日に複数回
// クリアしても連続日数は増やさない（1日1カウント、Supabase側でも on_conflict で防止）。
async function recordLatestClear() {
  const today = toDateStr(new Date());
  if (latestClearDates[0] && latestClearDates[0].date === today) return;
  try {
    await apiFetch('/api/latest-clears', { method: 'POST', body: JSON.stringify({ date: today, exempted: false }) });
    latestClearDates = [{ date: today, exempted: false }, ...latestClearDates.filter(d => d.date !== today)];
    renderLatestStreak();
  } catch {
    // ローカルサーバー未起動環境(GitHub Pages等)では記録できないが、クイズ自体は進行させる。
  }
}

// 「今日は免除にする」ボタンから呼ぶ。特別な理由で今日クリアできない場合、実際には
// クイズをやらずに、連続日数だけは途切れさせずに継続させる。
async function exemptToday() {
  const today = toDateStr(new Date());
  if (latestClearDates[0] && latestClearDates[0].date === today) {
    alert('今日の分は既に記録されています。');
    return;
  }
  if (!confirm('今日のLatest単語クリアを免除します（実際にはクイズを行わず、連続日数はそのまま継続扱いになります）。よろしいですか？')) return;
  const reason = (prompt('免除の理由（任意・空欄でも可）') || '').trim();
  try {
    await apiFetch('/api/latest-clears', {
      method: 'POST',
      body: JSON.stringify({ date: today, exempted: true, reason: reason || null }),
    });
    latestClearDates = [{ date: today, exempted: true }, ...latestClearDates.filter(d => d.date !== today)];
    renderLatestStreak();
  } catch (err) {
    alert('免除の登録に失敗しました: ' + err.message);
  }
}

function renderLatestStreak() {
  const { lastDate, lastExempted, streak } = computeLatestStreak(latestClearDates);
  const box = $('latestStreakBox');
  if (!lastDate) { box.hidden = true; return; }
  box.hidden = false;
  $('streakCount').textContent = `${streak}日連続達成中`;
  $('streakDateInfo').textContent = lastExempted ? `${lastDate}は免除` : `最終クリア: ${lastDate}`;
}

function loadGeminiKey() {
  try { return localStorage.getItem(LS_GEMINI_KEY) || ''; } catch { return ''; }
}
function saveGeminiKey(key) { localStorage.setItem(LS_GEMINI_KEY, key); }
function clearGeminiKey() { localStorage.removeItem(LS_GEMINI_KEY); }

// ---------- ローカルサーバー経由の書き込みAPI ----------
// 書き込み(insert/update/delete)はブラウザから直接Supabaseへは行わない
// (anonキーは読み取り専用に制限されている)。node server.js が
// SUPABASE_SERVICE_ROLE_KEY を使って代行する。GitHub Pages等、
// このサーバーが存在しない環境ではここが失敗する(意図した挙動)。
async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch {
    throw new Error('ローカルサーバー(node server.js)に接続できません。書き込みにはローカルサーバーが必要です。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (HTTP ${res.status})`);
  return data;
}

// ---------- Excel import（新規追加分のみSupabaseにinsert） ----------

async function importExcelFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  if (!wb.SheetNames.includes(SHEET_NAME)) {
    throw new Error(`シート "${SHEET_NAME}" が見つかりません。実在するシート: ${wb.SheetNames.join(', ')}`);
  }
  const ws = wb.Sheets[SHEET_NAME];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });

  const parsed = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const en = (r[4] ?? '').toString().trim();
    const ja = (r[5] ?? '').toString().trim();
    if (!en || !ja) continue;
    const marker = (r[3] ?? '').toString().trim() || null;
    parsed.push({ row: parsed.length + 1, en, ja, marker });
  }
  if (parsed.length === 0) {
    throw new Error('E列・F列に有効なデータが見つかりませんでした。');
  }

  const currentCount = words.length;
  const toInsert = parsed.length > currentCount ? parsed.slice(currentCount) : [];

  if (toInsert.length > 0) {
    await apiFetch('/api/words/import', { method: 'POST', body: JSON.stringify({ rows: toInsert }) });
    await refreshWords();
  }

  saveImportMeta({
    importedAt: new Date().toISOString(),
    fileName: file.name,
    latestAddedCount: toInsert.length,
  });

  return { addedCount: toInsert.length, totalCount: words.length };
}

// ---------- 単語の直接登録（AI和訳→選択登録。ローカルサーバー経由でのみ書き込み可能） ----------
// row は指定せずサーバーに送る。server.js側で、既存の最大rowに続く連番を自動採番する
// (2026-08-05〜。以前はnullのままにしていたが、登録番号を連番で振ってほしいという要望により変更)。
// ただしExcel側の "Wrk"シートNo.が将来この番号域まで伸びた場合、english_spabase_updateスキルの
// row一致判定と衝突しうる点には注意。

// AIの和訳応答は "English :: 日本語" 形式（1行1件、":: " がデリミタ）。
// スペル修正があった場合のみ行末に「（##スペル修正有）」が付くのでそれを取り除く。
// （##スペル修正有）/ ##（スペル修正有） の両表記ゆれに対応。
const SPELL_FIX_MARKER_RE = /(?:##[（(]スペル修正有[）)]|[（(]##スペル修正有[）)])/g;
function stripSpellFixMarker(s) {
  return (s || '').replace(SPELL_FIX_MARKER_RE, '').trim();
}

// "English :: 日本語" 形式のテキストをパースする。AIの和訳応答（##マーカー名は通常現れない）にも、
// 手動指定モードでの "English :: 日本語##マーカー名" 直接入力にも共通して使う。
function parseBulkWordsInput(text) {
  const rows = [];
  const errorLines = [];
  const lines = text.split('\n');
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    const delimIdx = line.indexOf('::');
    if (delimIdx === -1) {
      errorLines.push(i + 1);
      return;
    }
    const en = line.slice(0, delimIdx).trim();
    // ##（スペル修正有）等は、これより後ろの##をマーカー区切りと誤認しないよう先に除去する。
    let rest = stripSpellFixMarker(line.slice(delimIdx + 2).trim());
    let marker = null;
    const markerIdx = rest.indexOf('##');
    if (markerIdx !== -1) {
      marker = rest.slice(markerIdx + 2).trim() || null;
      rest = rest.slice(0, markerIdx).trim();
    }
    const ja = rest;
    if (!en || !ja) {
      errorLines.push(i + 1);
      return;
    }
    rows.push({ en, ja, marker });
  });
  return { rows, errorLines };
}

// 入力欄1の英単語・フレーズをAIに和訳してもらい、"English :: 日本語" 形式の候補を
// チェックボックス付きで一覧表示する。選択されたものだけをSupabaseへ一括登録し、
// 未選択（チェックを外した）ものは入力欄1に英語のみ戻す。

let registerCandidates = []; // AI応答をパースした候補 [{en, ja, marker}]

// デフォルトはAI和訳依頼方式('ai')。改定前の "English :: 日本語##マーカー" を
// 自分で直接指定する方式('manual')にも、ボタンでいつでも切り替えられるようにする。
let wordsRegisterMode = 'ai';

function setWordsRegisterMode(mode) {
  wordsRegisterMode = mode;
  const isManual = mode === 'manual';

  $('wordsRegisterModeDesc').textContent = isManual
    ? '"English :: 日本語" の形式（行末に "##マーカー名" を付けるとマーカーも設定）で、自分で和訳を指定してSupabaseに直接登録します（ローカルサーバー起動時のみ）。'
    : '英単語・フレーズをAIに和訳してもらい、選んだものだけをSupabaseに直接登録します（ローカルサーバー起動時のみ）。';
  $('wordsRegisterModeToggleBtn').textContent = isManual
    ? '🤖 AIに和訳を依頼する方式に切替'
    : '✏️ 自分で和訳を指定して登録';
  $('wordsRegisterInput1Label').textContent = isManual
    ? '1行1件、`English :: 日本語` 形式で貼り付けてください。行末に `##マーカー名` を付けるとマーカーも設定されます。'
    : '1行1件、英単語または英語表現を貼り付けてください。';
  $('wordsRegisterInput1').placeholder = isManual
    ? 'sophistry :: 詭弁；へりくつ\nhave an inkling :: うすうす感づいている##idiom'
    : 'sophistry\nhave an inkling';

  $('wordsRegisterAiTranslateBtn').hidden = isManual;
  $('wordsRegisterManualSaveBtn').hidden = !isManual;
  $('wordsRegisterCandidateBox').hidden = true;
  registerCandidates = [];
  $('wordsRegisterBulkError').textContent = '';
  $('wordsRegisterBulkStatus').textContent = '';
}

async function submitManualWordsRegister() {
  const input = $('wordsRegisterInput1');
  const errorEl = $('wordsRegisterBulkError');
  const statusEl = $('wordsRegisterBulkStatus');
  errorEl.textContent = '';
  statusEl.textContent = '';

  const { rows, errorLines } = parseBulkWordsInput(input.value);
  if (rows.length === 0) {
    errorEl.textContent = '登録できる行がありませんでした（"English :: 日本語" の形式で入力してください）。';
    return;
  }

  const btn = $('wordsRegisterManualSaveBtn');
  btn.disabled = true;
  try {
    const data = await apiFetch('/api/words/import', { method: 'POST', body: JSON.stringify({ rows }) });
    await refreshWords();
    let msg = `✅ ${data.inserted}件登録しました。`;
    if (errorLines.length) {
      msg += ` （形式が不正で無視した行: ${errorLines.join(', ')}行目）`;
    }
    statusEl.textContent = msg;
    input.value = '';
  } catch (err) {
    errorEl.textContent = '登録に失敗しました: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ブラウザから直接Gemini APIを呼ぶ経路（サーバーの prompts/word-translate.md と同内容を保持）。
function buildTranslatePrompt(wordListText) {
  return (
    `末尾に示す英単語・フレーズのリストについて、以下の形式で日本語訳を簡潔に示してください。\n\n` +
    `## 出力形式\n` +
    `- 1行＝1語（または1フレーズ）\n` +
    `- 「英語 :: 日本語の意味」で出力\n` +
    `- 前後に余計な言葉をいれず、出力そのもののみを表示する\n` +
    `- スペルミスがある場合は、修正した正しいスペルを左側に置く\n` +
    `- その場合のみ、行末に「（##スペル修正有）」を付ける\n` +
    `- 余計な空行は入れない\n` +
    `- 不自然だが意味が通じる場合は、日本語側に簡潔に注記する\n\n` +
    `## 入出力例\n` +
    `### 入力例\n` +
    `from bearich to doomsday\nquadripled\nbamboozle ...\nglaucoma\n\n` +
    `### 出力例\n` +
    `from bearish to doomsday :: 弱気から終末論的な悲観まで （##スペル修正有）\n` +
    `quadrupled :: 4倍になった （##スペル修正有）\n` +
    `bamboozle :: ...をだます；煙に巻く\n` +
    `glaucoma :: 緑内障\n\n` +
    `## 入力単語\n` +
    wordListText
  );
}

async function callGeminiTranslateDirect(wordListText, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildTranslatePrompt(wordListText) }] }] }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API エラー (HTTP ${res.status})`);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした。');
  return text;
}

async function callGeminiTranslateViaServer(wordListText) {
  const res = await fetch('/api/gemini-translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words: wordListText }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `エラー (HTTP ${res.status})`);
  return data.text;
}

function renderRegisterCandidates(rows) {
  registerCandidates = rows;
  const list = $('wordsRegisterCandidateList');
  list.innerHTML = rows.map((r, i) => `
    <label class="register-candidate-item">
      <input type="checkbox" class="register-candidate-checkbox" data-idx="${i}" checked>
      <span>${escapeHtml(r.en)} :: ${escapeHtml(r.ja)}</span>
    </label>
  `).join('');
  $('wordsRegisterCandidateBox').hidden = false;
}

async function requestAiTranslateBulk() {
  const input = $('wordsRegisterInput1');
  const btn = $('wordsRegisterAiTranslateBtn');
  const errorEl = $('wordsRegisterBulkError');
  const statusEl = $('wordsRegisterBulkStatus');
  errorEl.textContent = '';
  statusEl.textContent = '';

  const wordListText = input.value.trim();
  if (!wordListText) {
    errorEl.textContent = '単語・フレーズを1行1件で入力してください。';
    return;
  }

  $('wordsRegisterCandidateBox').hidden = true;
  registerCandidates = [];
  btn.disabled = true;
  btn.textContent = '和訳を取得中…';

  const key = loadGeminiKey();
  try {
    const text = key
      ? await callGeminiTranslateDirect(wordListText, key)
      : await callGeminiTranslateViaServer(wordListText);
    const { rows, errorLines } = parseBulkWordsInput(text);
    if (rows.length === 0) {
      errorEl.textContent = 'AIの応答から和訳候補を抽出できませんでした。';
      return;
    }
    renderRegisterCandidates(rows);
    if (errorLines.length) {
      const responseLines = text.split('\n');
      const failedLines = errorLines.map(n => responseLines[n - 1]).filter(Boolean);
      input.value = failedLines.join('\n');
      statusEl.textContent = `形式が読み取れなかった行が${errorLines.length}件あります（入力欄に戻しました）。`;
    } else {
      input.value = '';
    }
  } catch (err) {
    const hint = key
      ? '（保存されているAPIキーが正しいか、ホーム画面の「AI機能のAPIキー設定」から確認してください）'
      : '（この機能は node server.js でローカルサーバーを起動しているか、ホーム画面の「AI機能のAPIキー設定」でGemini APIキーを登録している場合のみ利用できます）';
    errorEl.textContent = 'AIへの和訳リクエストに失敗しました: ' + err.message + hint;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 AIに和訳を依頼';
  }
}

async function submitSelectedRegisterCandidates() {
  const input = $('wordsRegisterInput1');
  const errorEl = $('wordsRegisterBulkError');
  const statusEl = $('wordsRegisterBulkStatus');
  errorEl.textContent = '';
  statusEl.textContent = '';

  const checkboxes = [...document.querySelectorAll('.register-candidate-checkbox')];
  const checkedIdx = new Set(checkboxes.filter(c => c.checked).map(c => Number(c.dataset.idx)));
  const toRegister = registerCandidates.filter((_, i) => checkedIdx.has(i));
  const toReturn = registerCandidates.filter((_, i) => !checkedIdx.has(i));

  if (toRegister.length === 0) {
    errorEl.textContent = '登録する単語を1つ以上選択してください。';
    return;
  }

  const btn = $('wordsRegisterSubmitSelectedBtn');
  btn.disabled = true;
  try {
    const rows = toRegister.map(r => ({ en: r.en, ja: r.ja, marker: r.marker || null }));
    const data = await apiFetch('/api/words/import', { method: 'POST', body: JSON.stringify({ rows }) });
    await refreshWords();

    let msg = `✅ ${data.inserted}件登録しました。`;
    const existingText = input.value.trim();
    const returnLines = toReturn.map(r => r.en);
    if (returnLines.length) {
      input.value = [existingText, ...returnLines].filter(Boolean).join('\n');
      msg += ` （未選択の${returnLines.length}件は入力欄に戻しました）`;
    }
    statusEl.textContent = msg;

    $('wordsRegisterCandidateBox').hidden = true;
    registerCandidates = [];
  } catch (err) {
    errorEl.textContent = '登録に失敗しました: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- 全データ閲覧（ページング。現在ページ分だけを都度Supabaseから取得） ----------
// 起動時に全件読み込み済みの`words`配列には依存せず、このテーブルはページ単位で
// 直接Supabaseへ問い合わせる(件数が増えても画面を開く時間・メモリが一定に保たれる)。

const WORDS_TABLE_PAGE_SIZE = 100;
let wordsTablePage = 0;
let wordsTableTotalPages = 1;

// 全データ閲覧での複数選択削除用。選択状態は表示中のページ内でのみ保持し、
// ページ遷移（削除後の再読み込みも含む）のたびにクリアする。
let selectedWordIds = new Set();

function updateWordsTableDeleteBtn() {
  $('wordsTableSelectedCount').textContent = String(selectedWordIds.size);
  $('wordsTableDeleteBtn').disabled = selectedWordIds.size === 0;
}

async function loadWordsTablePage(page) {
  const tbody = $('wordsTableBody');
  const errorEl = $('wordsTableError');
  const countEl = $('wordsTableCount');
  const pageLabel = $('wordsTablePageLabel');
  const prevBtn = $('wordsTablePrevBtn');
  const nextBtn = $('wordsTableNextBtn');
  const pageInput = $('wordsTablePageInput');

  errorEl.textContent = '';
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  selectedWordIds.clear();
  $('wordsTableSelectAll').checked = false;
  updateWordsTableDeleteBtn();

  const from = page * WORDS_TABLE_PAGE_SIZE;
  const to = from + WORDS_TABLE_PAGE_SIZE - 1;

  try {
    // データ番号(row)の降順 = 直近に登録されたものが1ページ目の先頭に来る。
    const { data, error, count } = await sb
      .from('words')
      .select('id, row, en, ja, marker, ai_note', { count: 'exact' })
      .order('row', { ascending: false })
      .range(from, to);
    if (error) throw error;

    wordsTablePage = page;
    wordsTableTotalPages = Math.max(1, Math.ceil((count || 0) / WORDS_TABLE_PAGE_SIZE));
    countEl.textContent = `全 ${(count || 0).toLocaleString()} 件`;
    pageLabel.textContent = `${page + 1} / ${wordsTableTotalPages} ページ`;
    pageInput.placeholder = String(page + 1);
    pageInput.max = String(wordsTableTotalPages);

    // No.は実データのrow列の値ではなく、表示専用の通し番号（新しいものほど大きい番号に
    // なるよう全件数から逆算する）。削除してもrow列自体は詰めないため、Excel差分取り込み
    // (english_spabase_updateスキル)が前提とする「row値=Excel行番号」の対応関係は崩れない。
    tbody.innerHTML = data.map((w, i) => {
      const displayNo = (count || 0) - (from + i);
      return `
      <tr>
        <td><input type="checkbox" class="row-select" data-id="${w.id}"></td>
        <td><button type="button" class="row-edit-link" data-id="${w.id}" data-displayno="${displayNo}">${displayNo}</button></td>
        <td class="wrap">${escapeHtml(w.en)}</td>
        <td class="wrap">${escapeHtml(w.ja)}</td>
        <td>${escapeHtml(w.marker)}</td>
        <td class="ai-note-flag">${w.ai_note ? '✅' : ''}</td>
      </tr>
    `;
    }).join('');

    prevBtn.disabled = page <= 0;
    nextBtn.disabled = page >= wordsTableTotalPages - 1;
  } catch (err) {
    errorEl.textContent = '読み込みに失敗しました: ' + err.message;
    tbody.innerHTML = '';
  }
}

// 選択中の単語をまとめて削除する。削除後は同じページを再読み込みし、
// そのページが空になった場合（末尾ページの残り全件を削除した等）は1つ前へ戻る。
async function deleteSelectedWords() {
  const ids = [...selectedWordIds];
  if (!ids.length) return;
  if (!confirm(`選択した${ids.length}件の単語を削除します。元に戻せません。よろしいですか？`)) return;

  const errorEl = $('wordsTableError');
  errorEl.textContent = '';
  $('wordsTableDeleteBtn').disabled = true;
  try {
    await apiFetch('/api/words/delete-bulk', { method: 'POST', body: JSON.stringify({ ids }) });
    const idSet = new Set(ids);
    words = words.filter(w => !idSet.has(w.id));

    await loadWordsTablePage(wordsTablePage);
    if ($('wordsTableBody').children.length === 0 && wordsTablePage > 0) {
      await loadWordsTablePage(wordsTablePage - 1);
    }
  } catch (err) {
    errorEl.textContent = '削除に失敗しました: ' + err.message;
    updateWordsTableDeleteBtn();
  }
}

function jumpToWordsTablePage() {
  const input = $('wordsTablePageInput');
  const errorEl = $('wordsTableError');
  const n = parseInt(input.value, 10);
  if (!n || n < 1 || n > wordsTableTotalPages) {
    errorEl.textContent = `1〜${wordsTableTotalPages}の範囲でページ番号を入力してください。`;
    return;
  }
  input.value = '';
  loadWordsTablePage(n - 1);
}

function renderWordsTableView() {
  showScreen('wordsTableView');
  $('wordsTablePageInput').value = '';
  loadWordsTablePage(0);
}

// ---------- 単語編集（全データ閲覧のNo.クリックから。ローカルサーバー経由でのみ保存可能） ----------

let wordEditId = null;

// displayNoは呼び出し元(全データ閲覧の行)が表示していた通し番号。渡された場合は
// DB上のrow値ではなくこちらを見出しに使い、テーブルの表示と食い違わないようにする。
async function openWordEditFromTable(id, displayNo) {
  wordEditId = id;
  const errorEl = $('wordEditError');
  const statusEl = $('wordEditStatus');
  errorEl.textContent = '';
  statusEl.textContent = '';
  $('wordEditRowLabel').textContent = '読み込み中…';
  showScreen('wordEditView');

  try {
    const { data, error } = await sb
      .from('words')
      .select('id, row, en, ja, marker, ai_note')
      .eq('id', id)
      .single();
    if (error) throw error;

    $('wordEditRowLabel').textContent = `# ${displayNo ?? data.row ?? ''}`;
    $('wordEditEn').value = data.en || '';
    $('wordEditJa').value = data.ja || '';
    $('wordEditMarker').value = data.marker || '';
    $('wordEditAiNote').value = data.ai_note || '';
    const aiBtn = $('wordEditAiRequestBtn');
    aiBtn.disabled = false;
    aiBtn.textContent = '✨ 例文をAIにリクエスト';
  } catch (err) {
    $('wordEditRowLabel').textContent = '';
    errorEl.textContent = '読み込みに失敗しました: ' + err.message;
  }
}

// 編集画面上のEnglish/日本語（未保存の入力中の値でよい）を使ってAIに例文・補足を
// リクエストし、その場でAI補足欄に反映する。保存はこの画面の既存の「保存する」
// ボタンで行う（他のフィールドとまとめて編集・保存できるようにするため、
// クイズ画面のように生成直後の自動保存はしない）。
async function requestAiNoteForEdit() {
  const en = $('wordEditEn').value.trim();
  const ja = $('wordEditJa').value.trim();
  const errorEl = $('wordEditError');
  const statusEl = $('wordEditStatus');
  errorEl.textContent = '';
  statusEl.textContent = '';

  if (!en || !ja) {
    errorEl.textContent = 'Englishと日本語の両方を入力してから実行してください。';
    return;
  }

  const btn = $('wordEditAiRequestBtn');
  btn.disabled = true;
  btn.textContent = '生成中…';

  const key = loadGeminiKey();
  try {
    const text = key ? await callGeminiDirect(en, ja, key) : await callGeminiViaServer(en, ja);
    $('wordEditAiNote').value = text;
    statusEl.textContent = 'AI補足を生成しました。内容を確認し「保存する」で反映してください。';
  } catch (err) {
    const hint = key
      ? '（保存されているAPIキーが正しいか、ホーム画面の「AI機能のAPIキー設定」から確認してください）'
      : '（この機能は node server.js でローカルサーバーを起動しているか、ホーム画面の「AI機能のAPIキー設定」でGemini APIキーを登録している場合のみ利用できます）';
    errorEl.textContent = 'AI補足の取得に失敗しました: ' + err.message + hint;
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ 例文をAIにリクエスト';
  }
}

async function saveWordEditFromTable() {
  const errorEl = $('wordEditError');
  const statusEl = $('wordEditStatus');
  errorEl.textContent = '';
  statusEl.textContent = '';

  const en = $('wordEditEn').value.trim();
  const ja = $('wordEditJa').value.trim();
  const marker = $('wordEditMarker').value.trim();
  const aiNote = $('wordEditAiNote').value.trim();
  if (!en || !ja) {
    errorEl.textContent = '英語と日本語の両方を入力してください。';
    return;
  }

  try {
    await apiFetch(`/api/words/${encodeURIComponent(wordEditId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ en, ja, marker, ai_note: aiNote }),
    });
    const cached = words.find(x => x.id === wordEditId);
    if (cached) {
      cached.en = en;
      cached.ja = ja;
      cached.marker = marker || null;
      cached.ai_note = aiNote || null;
    }
    statusEl.textContent = '✅ 保存しました。';
    showScreen('wordsTableView');
    await loadWordsTablePage(wordsTablePage);
  } catch (err) {
    errorEl.textContent = '保存に失敗しました: ' + err.message;
  }
}

// ---------- CSVダウンロード（バックアップ。anon読み取りのみで完結し、ローカルサーバー不要） ----------

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportWordsCsv() {
  const columns = ['id', 'row', 'en', 'ja', 'marker', 'ai_note', 'created_at'];
  const lines = [columns.join(',')];
  for (const w of words) {
    lines.push(columns.map(c => csvEscape(w[c])).join(','));
  }
  const csv = '﻿' + lines.join('\r\n'); // BOM付き(Excelでの文字化け防止)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `spabase_english_words_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Sampling ----------

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// マーカー(D列由来)ごとのクイズモード用ラベル。未知のマーカーは値をそのまま表示する。
const MARKER_LABELS = { tips: 'Tips' };

// 「前回と同じテスト」ボタンのツールチップ表示用。実際に出題する単語には触れず、
// モード文字列だけから静的に説明文を組み立てる（pickWordsとは別の軽量な用途）。
function describeMode(mode) {
  if (!mode) return '';
  if (mode.startsWith('marker:')) {
    const list = mode.slice('marker:'.length).split(',').filter(Boolean);
    return `マーカー付き単語（${list.map(m => MARKER_LABELS[m] || m).join('・')}）`;
  }
  switch (mode) {
    case 'latest50': return 'Latest単語';
    case 'all': return '完全ランダム';
    case 'bottom300': return '下から300';
    case 'bottom100': return '下から100';
    case 'custom': return 'カスタム設定';
    default: return mode;
  }
}

function pickWords(allWords, mode, latestAddedCount) {
  let pool;
  let label;
  let quizSize = QUIZ_SIZE;
  if (mode.startsWith('marker:')) {
    const markerList = mode.slice('marker:'.length).split(',').filter(Boolean);
    const markerSet = new Set(markerList);
    pool = allWords.filter(w => w.marker && markerSet.has(w.marker));
    label = `マーカー付き単語（${markerList.map(m => MARKER_LABELS[m] || m).join('・')}）`;
    const n = Math.min(quizSize, pool.length);
    return { words: shuffle(pool).slice(0, n), label };
  }
  switch (mode) {
    case 'latest50': {
      const n = Math.max(1, latestAddedCount || 15);
      pool = allWords.slice(-n);
      label = `Latest単語(${n}個)`;
      quizSize = n;
      break;
    }
    case 'all':
      pool = allWords;
      label = '完全ランダム';
      break;
    case 'bottom300':
      pool = allWords.slice(-300);
      label = '下から300';
      break;
    case 'bottom100':
      pool = allWords.slice(-100);
      label = '下から100';
      break;
    default:
      throw new Error('unknown mode: ' + mode);
  }
  const n = Math.min(quizSize, pool.length);
  return { words: shuffle(pool).slice(0, n), label };
}

// ================================================================
// 更改メモ（単語データ・和英表現とは完全に独立）。
// このAI_Experiment配下の他アプリ(登山PDCAサイクル等)と共通のnotes.jsonパターンで
// 保持する。Supabase・localStorageのいずれにも保持しない。読み込みはnotes.jsonを
// 静的ファイルとしてそのままGETし、保存は配列まるごとをPOST /api/notes/save に
// 渡して上書きする（単一ユーザーが手動編集する小さなメモ一覧なのでこの単純な方式で
// 十分。words/expressions等の複数レコードAPIとは方針が異なる）。
// ================================================================

async function saveNotesToFile(list) {
  await apiFetch('/api/notes/save', { method: 'POST', body: JSON.stringify({ notes: list }) });
}

async function addNoteItem(text) {
  const nextId = notes.reduce((max, n) => Math.max(max, n.id), 0) + 1;
  const list = [...notes, { id: nextId, text, createdAt: new Date().toISOString() }];
  await saveNotesToFile(list);
  notes = list;
}
async function updateNoteItem(id, text) {
  const list = notes.map(n => (n.id === id ? { ...n, text } : n));
  await saveNotesToFile(list);
  notes = list;
}
async function deleteNoteItem(id) {
  const list = notes.filter(n => n.id !== id);
  await saveNotesToFile(list);
  notes = list;
}

function renderNotesList() {
  $('notesErrorMsg').textContent = '';
  $('notesInput').value = '';

  const ul = $('notesList');
  ul.innerHTML = '';

  for (const n of notes.slice().reverse()) { // 新しい登録を上に
    const li = document.createElement('li');

    if (n.id === editingNoteId) {
      const ta = document.createElement('textarea');
      ta.className = 'waei-textarea';
      ta.rows = 3;
      ta.value = n.text;
      li.appendChild(ta);

      const actions = document.createElement('div');
      actions.className = 'waei-item-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = '保存';
      saveBtn.addEventListener('click', async () => {
        const text = ta.value.trim();
        if (!text) return;
        try {
          await updateNoteItem(n.id, text);
          editingNoteId = null;
          renderNotesList();
        } catch (err) {
          $('notesErrorMsg').textContent = '保存に失敗しました: ' + err.message;
        }
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.addEventListener('click', () => { editingNoteId = null; renderNotesList(); });
      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      li.appendChild(actions);
    } else {
      const dateDiv = document.createElement('div');
      dateDiv.className = 'waei-item-ja';
      dateDiv.textContent = new Date(n.createdAt).toLocaleString('ja-JP');

      const textDiv = document.createElement('div');
      textDiv.className = 'waei-item-en';
      textDiv.style.whiteSpace = 'pre-wrap';
      textDiv.textContent = n.text;

      const actions = document.createElement('div');
      actions.className = 'waei-item-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => { editingNoteId = n.id; renderNotesList(); });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', async () => {
        if (!confirm('このメモを削除しますか？')) return;
        try {
          await deleteNoteItem(n.id);
          renderNotesList();
        } catch (err) {
          $('notesErrorMsg').textContent = '削除に失敗しました: ' + err.message;
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      li.appendChild(dateDiv);
      li.appendChild(textDiv);
      li.appendChild(actions);
    }

    ul.appendChild(li);
  }
}

async function submitNewNote() {
  const text = $('notesInput').value.trim();
  if (!text) return;
  try {
    await addNoteItem(text);
    renderNotesList();
  } catch (err) {
    $('notesErrorMsg').textContent = '保存に失敗しました: ' + err.message;
  }
}

// ================================================================
// 和英表現練習（単語クイズとはデータ・localStorageキーとも独立。データ本体はSupabase）
// ================================================================

async function addWaeiItem(ja, en) {
  await apiFetch('/api/expressions', { method: 'POST', body: JSON.stringify({ ja, en }) });
  await refreshExpressions();
}
async function updateWaeiItem(id, ja, en) {
  await apiFetch(`/api/expressions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ja, en }) });
  await refreshExpressions();
}
async function deleteWaeiItem(id) {
  await apiFetch(`/api/expressions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshExpressions();
}

function loadWaeiSession() {
  try {
    const s = localStorage.getItem(LS_WAEI_SESSION);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
function saveWaeiSession(s) { localStorage.setItem(LS_WAEI_SESSION, JSON.stringify(s)); }
function clearWaeiSession() { localStorage.removeItem(LS_WAEI_SESSION); }

// ---------- 和英表現練習：ホーム ----------

function renderWaeiHome() {
  const session = loadWaeiSession();
  const count = expressions.length;

  $('waeiCountText').textContent = count
    ? `登録問題数: ${count} 個`
    : '問題が登録されていません。「問題を登録・編集する」から追加してください。';

  $('waeiStartAllBtn').disabled = count === 0;
  $('waeiCustomStartBtn').disabled = count === 0;
  if (count) {
    $('waeiCustomX').value = Math.min(Math.max(1, parseInt($('waeiCustomX').value) || 10), count);
  }

  const resumeBtn = $('waeiResumeBtn');
  if (session && session.items && session.currentIndex < session.items.length) {
    resumeBtn.hidden = false;
    resumeBtn.textContent = `前回の続きから（${session.round}周目 ${session.currentIndex + 1}/${session.items.length}）`;
  } else {
    resumeBtn.hidden = true;
  }

  $('waeiErrorMsg').textContent = '';
  renderStatusBar('ok');
  showScreen('waeiHome');
}

// ---------- 和英表現練習：登録・編集 ----------

let waeiEditingId = null;

function resetWaeiForm() {
  waeiEditingId = null;
  $('waeiInputJa').value = '';
  $('waeiInputEn').value = '';
  $('waeiSaveItemBtn').textContent = '登録する';
  $('waeiCancelEditBtn').hidden = true;
  $('waeiFormError').textContent = '';
}

function renderWaeiForm() {
  resetWaeiForm();
  renderWaeiItemList();
  showScreen('waeiForm');
}

function renderWaeiItemList() {
  const ul = $('waeiItemList');
  ul.innerHTML = '';
  const items = expressions.slice().reverse(); // 新しい登録を上に
  for (const it of items) {
    const li = document.createElement('li');

    const jaDiv = document.createElement('div');
    jaDiv.className = 'waei-item-ja';
    jaDiv.textContent = it.ja;

    const enDiv = document.createElement('div');
    enDiv.className = 'waei-item-en';
    enDiv.textContent = it.en;

    const actions = document.createElement('div');
    actions.className = 'waei-item-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => startEditWaeiItem(it.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async () => {
      if (!confirm('この問題を削除しますか？')) return;
      await deleteWaeiItem(it.id);
      if (waeiEditingId === it.id) resetWaeiForm();
      renderWaeiItemList();
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(jaDiv);
    li.appendChild(enDiv);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

function startEditWaeiItem(id) {
  const it = expressions.find((i) => i.id === id);
  if (!it) return;
  waeiEditingId = id;
  $('waeiInputJa').value = it.ja;
  $('waeiInputEn').value = it.en;
  $('waeiSaveItemBtn').textContent = '更新する';
  $('waeiCancelEditBtn').hidden = false;
  $('waeiFormError').textContent = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- 和英表現練習：テスト ----------

function startWaeiQuiz(count) {
  if (!expressions.length) return;
  const n = Math.min(Math.max(1, count), expressions.length);
  const session = {
    round: 1,
    currentIndex: 0,
    items: shuffle(expressions).slice(0, n),
    wrongIds: [],
    revealed: false,
  };
  saveWaeiSession(session);
  renderWaeiQuiz();
}

function renderWaeiQuiz() {
  const session = loadWaeiSession();
  if (!session) { renderWaeiHome(); return; }
  if (session.currentIndex >= session.items.length) { renderWaeiResult(); return; }

  const it = session.items[session.currentIndex];
  $('waeiRoundLabel').textContent = `${session.round}周目`;
  $('waeiProgressLabel').textContent = `${session.currentIndex + 1} / ${session.items.length}`;
  $('waeiJaText').textContent = it.ja;
  $('waeiEnText').textContent = it.en;

  if (session.revealed) {
    $('waeiEnText').hidden = false;
    $('waeiRevealBtn').hidden = true;
    $('waeiJudgeButtons').hidden = false;
  } else {
    $('waeiEnText').hidden = true;
    $('waeiRevealBtn').hidden = false;
    $('waeiJudgeButtons').hidden = true;
  }

  showScreen('waeiQuiz');
}

function waeiReveal() {
  const session = loadWaeiSession();
  if (!session) return;
  session.revealed = true;
  saveWaeiSession(session);
  renderWaeiQuiz();
}

function waeiJudge(isCorrect) {
  const session = loadWaeiSession();
  if (!session) return;
  const it = session.items[session.currentIndex];
  if (!isCorrect) session.wrongIds.push(it.id);
  session.currentIndex += 1;
  session.revealed = false;
  saveWaeiSession(session);
  if (session.currentIndex >= session.items.length) {
    renderWaeiResult();
  } else {
    renderWaeiQuiz();
  }
}

// ---------- 和英表現練習：結果 ----------

function renderWaeiResult() {
  const session = loadWaeiSession();
  if (!session) { renderWaeiHome(); return; }
  const wrongs = session.items.filter((it) => session.wrongIds.includes(it.id));
  const allCorrect = wrongs.length === 0;

  if (allCorrect) {
    $('waeiResultTitle').textContent = `🎉 ${session.round}周目で全問正解！`;
    $('waeiResultDetail').textContent = `${session.items.length} 問すべてできました。お疲れさまでした。`;
    $('waeiWrongList').innerHTML = '';
    $('waeiNextRoundBtn').hidden = true;
  } else {
    $('waeiResultTitle').textContent = `${session.round}周目 結果`;
    $('waeiResultDetail').textContent = `できた ${session.items.length - wrongs.length} / ${session.items.length}　できなかった ${wrongs.length} 個`;
    const ul = $('waeiWrongList');
    ul.innerHTML = '';
    for (const it of wrongs) {
      const li = document.createElement('li');
      const ja = document.createElement('span');
      ja.className = 'en';
      ja.textContent = it.ja;
      const en = document.createElement('span');
      en.className = 'ja';
      en.textContent = it.en;
      li.appendChild(ja);
      li.appendChild(en);
      ul.appendChild(li);
    }
    $('waeiNextRoundBtn').hidden = false;
  }
  showScreen('waeiResult');
}

function waeiNextRound() {
  const session = loadWaeiSession();
  if (!session) { renderWaeiHome(); return; }
  const wrongs = session.items.filter((it) => session.wrongIds.includes(it.id));
  if (wrongs.length === 0) {
    clearWaeiSession();
    renderWaeiHome();
    return;
  }
  session.round += 1;
  session.currentIndex = 0;
  session.items = shuffle(wrongs);
  session.wrongIds = [];
  session.revealed = false;
  saveWaeiSession(session);
  renderWaeiQuiz();
}

// ---------- Home rendering ----------

function renderMarkerButtons() {
  const box = $('markerFilterBox');
  const container = $('markerChecklist');
  container.innerHTML = '';
  $('markerFilterError').textContent = '';
  const markers = [...new Set(words.map(w => w.marker).filter(Boolean))].sort();

  if (markers.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  for (const marker of markers) {
    const count = words.filter(w => w.marker === marker).length;
    const label = document.createElement('label');
    label.className = 'marker-checklist-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = marker;
    checkbox.className = 'marker-checkbox';
    checkbox.checked = true;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(`${MARKER_LABELS[marker] || marker}（${count}個）`));
    container.appendChild(label);
  }
}

function startMarkerTest() {
  const checked = [...document.querySelectorAll('.marker-checkbox:checked')].map(c => c.value);
  const errorEl = $('markerFilterError');
  if (checked.length === 0) {
    errorEl.textContent = '対象マーカーを1つ以上選択してください。';
    return;
  }
  errorEl.textContent = '';
  const existing = loadSession();
  if (existing && existing.currentIndex < existing.words.length) {
    if (!confirm('進行中のクイズがあります。新しく始めると進捗は失われます。続けますか？')) return;
  }
  clearSession();
  startNewSession(`marker:${checked.join(',')}`);
}

function renderHome() {
  const session = loadSession();
  renderMarkerButtons();
  const modeBtns = document.querySelectorAll('.mode-btn');
  const meta = loadImportMeta();

  if (words.length) {
    $('wordCountText').textContent = `登録単語数: ${words.length.toLocaleString()} 個`;
    if (meta) {
      const dt = new Date(meta.importedAt);
      $('lastImportText').textContent = `最終取り込み: ${dt.toLocaleString('ja-JP')}（${meta.fileName}・追加${meta.latestAddedCount}個）`;
    } else {
      $('lastImportText').textContent = '';
    }
    const latestN = Math.max(1, (meta && meta.latestAddedCount) || 15);
    $('latest50Title').textContent = `Latest単語(${latestN}個)`;
    modeBtns.forEach(b => b.disabled = false);
  } else {
    $('wordCountText').textContent = '単語データがありません。下の「データ再取り込み」から Excel を読み込んでください。';
    $('lastImportText').textContent = '';
    modeBtns.forEach(b => b.disabled = true);
  }

  const custom = loadCustomSettings();
  $('customX').value = custom.x;
  $('customY').value = custom.y;
  $('customStartBtn').disabled = words.length === 0;

  // 「前回の続きから」「前回と同じテスト」は対のボタンとして扱う。前回のテストの手がかり
  // (lastMode)が少しでもあれば両方とも表示し、実際に再開できるセッションが無い場合
  // （完全クリア後など）は左の「前回の続きから」だけをグレーアウトする（隠さない）。
  const resumeBtn = $('resumeBtn');
  const repeatBtn = $('repeatLastTestBtn');
  const lastMode = getEffectiveLastMode();
  const resumable = !!(session && session.words && session.currentIndex < session.words.length);

  if (lastMode && words.length) {
    repeatBtn.hidden = false;
    repeatBtn.title = `前回選んだテスト: ${describeMode(lastMode)}`;

    resumeBtn.hidden = false;
    resumeBtn.disabled = !resumable;
    // ボタン本体は短く「前回の続きから」のみとし、状況の詳細はホバー時のツールチップ(title)で示す。
    resumeBtn.title = resumable
      ? `${session.modeLabel} / ${session.round}周目 ${session.currentIndex + 1}/${session.words.length}`
      : '再開できるクイズはありません（前回のテストは完了済みです）';
  } else {
    resumeBtn.hidden = true;
    repeatBtn.hidden = true;
  }

  renderLatestStreak();

  $('errorMsg').textContent = '';
  renderAiKeyStatus();
  renderStatusBar('ok');
  showScreen('home');
}

function renderAiKeyStatus() {
  const key = loadGeminiKey();
  $('aiKeyStatus').textContent = key
    ? '✅ APIキーを保存済みです。この端末ではAIリクエストが直接Googleに送られます。'
    : '未設定です。未設定の場合、ローカルサーバー(node server.js)経由での利用を試みます。';
  $('aiKeyInput').value = '';
  $('aiKeyInput').placeholder = key ? '(保存済み。変更する場合のみ入力)' : 'Gemini APIキーを入力';
}

// ---------- Quiz ----------

function startCustomSession() {
  if (!words.length) return;
  const x = Math.max(1, parseInt($('customX').value) || 15);
  const y = Math.max(1, parseInt($('customY').value) || 5000);
  saveCustomSettings(x, y);
  saveLastMode('custom');
  const effectiveY = Math.min(y, words.length);
  const pool = words.slice(-effectiveY);
  const n = Math.min(x, pool.length);
  const session = {
    mode: 'custom',
    modeLabel: `最新${effectiveY}件から${n}問`,
    round: 1,
    currentIndex: 0,
    words: shuffle(pool).slice(0, n),
    wrongIndices: [],
    revealed: false,
  };
  saveSession(session);
  renderQuiz();
}

function startNewSession(mode) {
  if (!words.length) return;
  saveLastMode(mode);
  const meta = loadImportMeta();
  const { words: picked, label } = pickWords(words, mode, meta && meta.latestAddedCount);
  const session = {
    mode,
    modeLabel: label,
    round: 1,
    currentIndex: 0,
    words: picked,
    wrongIndices: [],
    revealed: false,
  };
  saveSession(session);
  renderQuiz();
}

function renderQuiz() {
  const session = loadSession();
  if (!session) { renderHome(); return; }
  if (session.currentIndex >= session.words.length) {
    renderRoundResult();
    return;
  }
  const w = session.words[session.currentIndex];
  $('roundLabel').textContent = `${session.round}周目（${session.modeLabel}）`;
  $('progressLabel').textContent = `${session.currentIndex + 1} / ${session.words.length}`;
  $('rowNum').textContent = `# ${w.row}`;
  $('englishWord').textContent = w.en;
  $('japaneseWord').textContent = w.ja;

  if (session.revealed) {
    $('japaneseWord').hidden = false;
    $('revealBtn').hidden = true;
    $('judgeButtons').hidden = false;
    $('aiExampleBox').hidden = false;
    $('editWordBtn').hidden = false;
  } else {
    $('japaneseWord').hidden = true;
    $('revealBtn').hidden = false;
    $('judgeButtons').hidden = true;
    $('aiExampleBox').hidden = true;
    $('editWordBtn').hidden = true;
  }
  $('editWordBox').hidden = true;
  $('editWordError').textContent = '';

  const aiBtn = $('aiExampleBtn');
  const aiResult = $('aiExampleResult');
  const saveBtn = $('saveAiNoteBtn');
  const saveStatus = $('saveAiNoteStatus');
  saveStatus.hidden = true;
  saveStatus.textContent = '';

  if (w.ai_note) {
    // 保存済みの補足があれば、AIへの再リクエストなしに最初から回答として表示する。
    lastAiNoteWordId = w.id;
    lastAiNoteText = w.ai_note;
    aiResult.innerHTML = markdownToHtml(w.ai_note);
    aiResult.hidden = false;
    aiBtn.hidden = true;
    saveBtn.hidden = true;
  } else {
    lastAiNoteWordId = null;
    lastAiNoteText = null;
    aiBtn.hidden = false;
    aiBtn.disabled = false;
    aiBtn.textContent = '✨ 例文をAIにリクエスト';
    aiResult.hidden = true;
    aiResult.textContent = '';
    saveBtn.hidden = true;
  }

  showScreen('quiz');
}

// ---------- クイズ中の単語編集（English/日本語/AI補足。ローカルサーバー経由でのみ書き込み可能） ----------

function openEditWord() {
  const session = loadSession();
  if (!session) return;
  const w = session.words[session.currentIndex];
  $('editWordEn').value = w.en;
  $('editWordJa').value = w.ja;
  $('editWordAiNote').value = w.ai_note || '';
  $('editWordError').textContent = '';
  $('editWordBox').hidden = false;
  $('judgeButtons').hidden = true;
  $('editWordBtn').hidden = true;
}

function closeEditWord() {
  $('editWordBox').hidden = true;
  $('judgeButtons').hidden = false;
  $('editWordBtn').hidden = false;
}

async function saveEditWord() {
  const session = loadSession();
  if (!session) return;
  const idx = session.currentIndex;
  const w = session.words[idx];
  const errorEl = $('editWordError');
  errorEl.textContent = '';

  const en = $('editWordEn').value.trim();
  const ja = $('editWordJa').value.trim();
  const aiNote = $('editWordAiNote').value.trim();
  if (!en || !ja) {
    errorEl.textContent = '英語と日本語の両方を入力してください。';
    return;
  }

  try {
    const { item } = await apiFetch(`/api/words/${encodeURIComponent(w.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ en, ja, ai_note: aiNote }),
    });

    // セッション・グローバルキャッシュ双方に反映し、画面に即座に反映する。
    session.words[idx] = { ...w, en: item.en, ja: item.ja, ai_note: item.ai_note };
    saveSession(session);
    const cached = words.find(x => x.id === w.id);
    if (cached) {
      cached.en = item.en;
      cached.ja = item.ja;
      cached.ai_note = item.ai_note;
    }

    closeEditWord();
    renderQuiz();
  } catch (err) {
    errorEl.textContent = '保存に失敗しました: ' + err.message;
  }
}

// ---------- 簡易Markdownレンダリング ----------

function escapeHtml(s) {
  return (s ?? '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');
  return s;
}

function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let listType = null;
  let paragraphLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length) {
      htmlParts.push(`<p>${paragraphLines.map(renderInline).join('<br>')}</p>`);
      paragraphLines = [];
    }
  };
  const closeList = () => {
    if (listType) {
      htmlParts.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') { flushParagraph(); closeList(); continue; }

    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      flushParagraph();
      closeList();
      const level = Math.min(headerMatch[1].length + 2, 6);
      htmlParts.push(`<h${level}>${renderInline(headerMatch[2])}</h${level}>`);
      continue;
    }

    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType !== 'ul') { closeList(); htmlParts.push('<ul>'); listType = 'ul'; }
      htmlParts.push(`<li>${renderInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\d+[.)]\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      if (listType !== 'ol') { closeList(); htmlParts.push('<ol>'); listType = 'ol'; }
      htmlParts.push(`<li>${renderInline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    paragraphLines.push(line);
  }
  flushParagraph();
  closeList();
  return htmlParts.join('');
}

// ---------- AI例文リクエスト ----------

function buildGeminiPrompt(en, ja) {
  return (
    `英単語「${en}」（日本語訳: 「${ja}」）について、日本語で簡潔に回答してください。\n` +
    `1. 発音記号（IPA）と、カタカナで表現するなら何に近いかを示してください。カタカナ表記のうち、アクセント（強く読む部分）に当たる箇所は **太字** にしてください。\n` +
    `2. 品詞分類を、あてはまるものをすべて列挙してください（例: 名詞 / 自動詞 / 他動詞 / 形容詞 / 副詞 など）。特に動詞の場合は、自動詞・他動詞のどちらか、あるいは両方の用法があるかを明確にしてください。複数の品詞・用法がある場合、実際によく使われるのはどれかという傾向があれば、その旨も記載してください（例:「主に他動詞として使われる」等）。特に補足すべき傾向がなければその旨は省略して構いません。\n` +
    `3. この単語を使った例文を3つ、英語とその日本語訳のペアで挙げてください。\n` +
    `4. 日本語訳「${ja}」だけでは伝わりにくいニュアンスや使い分けがあれば、2〜3行で補足してください。特になければ「特になし」としてください。\n` +
    `見出しや箇条書きを使い、読みやすく整形してください。`
  );
}

// ブラウザから直接Gemini APIを呼ぶ経路。この端末のlocalStorageに保存されたキーのみを使用する。
async function callGeminiDirect(en, ja, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildGeminiPrompt(en, ja) }] }] }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API エラー (HTTP ${res.status})`);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした。');
  return text;
}

// ローカル開発サーバー(node server.js)経由の経路。キーはサーバー側の環境変数から読まれる。
async function callGeminiViaServer(en, ja) {
  const res = await fetch('/api/gemini-examples', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ en, ja }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `エラー (HTTP ${res.status})`);
  return data.text;
}

async function requestAiExamples() {
  const session = loadSession();
  if (!session) return;
  const w = session.words[session.currentIndex];
  const btn = $('aiExampleBtn');
  const resultEl = $('aiExampleResult');

  btn.disabled = true;
  btn.textContent = '生成中…';
  resultEl.hidden = true;

  const key = loadGeminiKey();
  try {
    const text = key ? await callGeminiDirect(w.en, w.ja, key) : await callGeminiViaServer(w.en, w.ja);
    resultEl.innerHTML = markdownToHtml(text);
    resultEl.hidden = false;
    btn.hidden = true;
    lastAiNoteWordId = w.id;
    lastAiNoteText = text;
    // この時点でこの単語にはまだAI補足が保存されていないので、手動保存を待たず即座に保存する。
    const saveBtn = $('saveAiNoteBtn');
    saveBtn.hidden = true;
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 この補足を保存する';
    await saveAiNote();
  } catch (err) {
    const hint = key
      ? '（保存されているAPIキーが正しいか、ホーム画面の「AI機能のAPIキー設定」から確認してください）'
      : '（この機能は node server.js でローカルサーバーを起動しているか、ホーム画面の「AI機能のAPIキー設定」でGemini APIキーを登録している場合のみ利用できます）';
    const msg = 'AI例文の取得に失敗しました: ' + err.message + '\n' + hint;
    resultEl.innerHTML = escapeHtml(msg).replace(/\n/g, '<br>');
    resultEl.hidden = false;
    btn.disabled = false;
    btn.textContent = '✨ 例文をAIにリクエスト';
    lastAiNoteWordId = null;
    lastAiNoteText = null;
  }
}

// AIリクエスト結果を、その単語に紐づけてSupabaseへ保存する（ローカルサーバー経由のみ）。
async function saveAiNote() {
  if (!lastAiNoteWordId || !lastAiNoteText) return;
  const btn = $('saveAiNoteBtn');
  const status = $('saveAiNoteStatus');
  btn.disabled = true;
  status.hidden = false;
  status.textContent = '保存中…';
  try {
    await apiFetch(`/api/words/${encodeURIComponent(lastAiNoteWordId)}/ai-note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: lastAiNoteText }),
    });
    const cached = words.find(x => x.id === lastAiNoteWordId);
    if (cached) cached.ai_note = lastAiNoteText;
    const session = loadSession();
    if (session) {
      const sw = session.words[session.currentIndex];
      if (sw && sw.id === lastAiNoteWordId) {
        sw.ai_note = lastAiNoteText;
        saveSession(session);
      }
    }
    status.textContent = '✅ 保存しました。次回以降この単語の回答として表示されます。';
    btn.hidden = true;
  } catch (err) {
    status.textContent = '保存に失敗しました: ' + err.message;
    btn.hidden = false;
    btn.disabled = false;
  }
}

function reveal() {
  const session = loadSession();
  if (!session) return;
  session.revealed = true;
  saveSession(session);
  renderQuiz();
}

function judge(isCorrect) {
  const session = loadSession();
  if (!session) return;
  if (!isCorrect) session.wrongIndices.push(session.currentIndex);
  session.currentIndex += 1;
  session.revealed = false;
  saveSession(session);
  if (session.currentIndex >= session.words.length) {
    renderRoundResult();
  } else {
    renderQuiz();
  }
}

// ---------- Round result ----------

function renderRoundResult() {
  const session = loadSession();
  if (!session) { renderHome(); return; }
  const wrongs = session.wrongIndices.map(i => session.words[i]);
  const allCorrect = wrongs.length === 0;

  if (allCorrect) {
    if (isStreakEligible(session)) recordLatestClear();
    $('resultTitle').textContent = `🎉 ${session.round}周目で全問正解！クリアです`;
    $('resultDetail').textContent = `${session.words.length} 問すべて正解しました。お疲れさまでした。`;
    $('wrongList').innerHTML = '';
    $('nextRoundBtn').hidden = true;
  } else {
    $('resultTitle').textContent = `${session.round}周目 結果`;
    $('resultDetail').textContent = `正解 ${session.words.length - wrongs.length} / ${session.words.length}　不正解 ${wrongs.length} 個`;
    const ul = $('wrongList');
    ul.innerHTML = '';
    for (const w of wrongs) {
      const li = document.createElement('li');
      const en = document.createElement('span');
      en.className = 'en';
      en.textContent = `# ${w.row}  ${w.en}`;
      const ja = document.createElement('span');
      ja.className = 'ja';
      ja.textContent = w.ja;
      li.appendChild(en);
      li.appendChild(ja);
      ul.appendChild(li);
    }
    $('nextRoundBtn').hidden = false;
  }
  showScreen('result');
}

function nextRound() {
  const session = loadSession();
  if (!session) { renderHome(); return; }
  const wrongs = session.wrongIndices.map(i => session.words[i]);
  if (wrongs.length === 0) {
    clearSession();
    renderHome();
    return;
  }
  session.round += 1;
  session.currentIndex = 0;
  session.words = shuffle(wrongs);
  session.wrongIndices = [];
  session.revealed = false;
  saveSession(session);
  renderQuiz();
}

// ---------- Event wiring ----------

function showError(msg) {
  $('errorMsg').textContent = msg;
}

function bindEvents() {
  $('fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showError('読み込み中…');
    try {
      const result = await importExcelFile(f);
      e.target.value = '';
      renderHome();
      if (result.addedCount > 0) {
        showError(`Supabaseに ${result.addedCount} 個の単語を追加登録しました（合計 ${result.totalCount} 個）。`);
      } else {
        showError('新しい単語はありませんでした（Excel内の件数がSupabase上の件数以下でした）。');
      }
    } catch (err) {
      showError('読み込みに失敗しました: ' + err.message);
    }
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const mode = btn.dataset.mode;
      if (!mode) return; // customStartBtn等、data-modeを持たない.mode-btnは専用リスナー側で処理する
      const existing = loadSession();
      if (existing && existing.currentIndex < existing.words.length) {
        if (!confirm('進行中のクイズがあります。新しく始めると進捗は失われます。続けますか？')) return;
      }
      clearSession();
      startNewSession(mode);
    });
  });

  $('markerTestStartBtn').addEventListener('click', startMarkerTest);
  $('latest50ExemptBtn').addEventListener('click', exemptToday);

  $('resumeBtn').addEventListener('click', () => {
    const s = loadSession();
    if (s) renderQuiz();
  });

  $('repeatLastTestBtn').addEventListener('click', () => {
    const lastMode = getEffectiveLastMode();
    if (!lastMode) return;
    const existing = loadSession();
    if (existing && existing.currentIndex < existing.words.length) {
      if (!confirm('進行中のクイズがあります。新しく始めると進捗は失われます。続けますか？')) return;
    }
    clearSession();
    if (lastMode === 'custom') startCustomSession();
    else startNewSession(lastMode);
  });

  $('exportCsvBtn').addEventListener('click', exportWordsCsv);

  $('backBtn').addEventListener('click', () => {
    if (confirm('クイズを中断しますか？\n進捗は自動保存されているので、ホームの「前回の続きから」でいつでも再開できます。')) {
      renderHome();
    }
  });

  $('revealBtn').addEventListener('click', reveal);
  $('aiExampleBtn').addEventListener('click', requestAiExamples);
  $('saveAiNoteBtn').addEventListener('click', saveAiNote);
  $('correctBtn').addEventListener('click', () => judge(true));
  $('wrongBtn').addEventListener('click', () => judge(false));
  $('editWordBtn').addEventListener('click', openEditWord);
  $('editWordCancelBtn').addEventListener('click', closeEditWord);
  $('editWordSaveBtn').addEventListener('click', saveEditWord);

  $('customStartBtn').addEventListener('click', () => {
    if ($('customStartBtn').disabled) return;
    const existing = loadSession();
    if (existing && existing.currentIndex < existing.words.length) {
      if (!confirm('進行中のクイズがあります。新しく始めると進捗は失われます。続けますか？')) return;
    }
    clearSession();
    startCustomSession();
  });

  $('aiKeyToggleBtn').addEventListener('click', () => {
    $('aiKeyPanel').hidden = !$('aiKeyPanel').hidden;
  });

  $('aiKeySaveBtn').addEventListener('click', () => {
    const v = $('aiKeyInput').value.trim();
    if (!v) { alert('APIキーを入力してください。'); return; }
    saveGeminiKey(v);
    renderAiKeyStatus();
    alert('この端末にAPIキーを保存しました。');
  });

  $('aiKeyClearBtn').addEventListener('click', () => {
    if (!loadGeminiKey()) return;
    if (!confirm('この端末に保存済みのAPIキーを削除しますか？')) return;
    clearGeminiKey();
    renderAiKeyStatus();
  });

  $('nextRoundBtn').addEventListener('click', nextRound);
  $('homeBtn').addEventListener('click', () => {
    const s = loadSession();
    if (s && s.wrongIndices && s.wrongIndices.length === 0 && s.currentIndex >= s.words.length) {
      clearSession();
    }
    renderHome();
  });

  // ---- 和英表現練習 ----

  $('goWaeiBtn').addEventListener('click', () => renderWaeiHome());

  // ---- 単語を直接登録 ----

  $('goWordsRegisterBtn').addEventListener('click', () => {
    $('wordsRegisterInput1').value = '';
    setWordsRegisterMode('ai'); // 画面を開くたびデフォルト(AI和訳依頼)に戻す
    showScreen('wordsRegister');
  });
  $('wordsRegisterBackBtn').addEventListener('click', () => renderHome());
  $('wordsRegisterModeToggleBtn').addEventListener('click', () => {
    setWordsRegisterMode(wordsRegisterMode === 'ai' ? 'manual' : 'ai');
  });
  $('wordsRegisterAiTranslateBtn').addEventListener('click', requestAiTranslateBulk);
  $('wordsRegisterSubmitSelectedBtn').addEventListener('click', submitSelectedRegisterCandidates);
  $('wordsRegisterManualSaveBtn').addEventListener('click', submitManualWordsRegister);

  // ---- 全データ閲覧 ----

  $('goWordsTableBtn').addEventListener('click', () => renderWordsTableView());
  $('wordsTableBackBtn').addEventListener('click', () => renderHome());
  $('wordsTablePrevBtn').addEventListener('click', () => {
    if (wordsTablePage > 0) loadWordsTablePage(wordsTablePage - 1);
  });
  $('wordsTableNextBtn').addEventListener('click', () => {
    loadWordsTablePage(wordsTablePage + 1);
  });
  $('wordsTablePageJumpBtn').addEventListener('click', jumpToWordsTablePage);
  $('wordsTablePageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') jumpToWordsTablePage();
  });
  // 行は都度innerHTMLで再生成されるため、tbody自体にイベント委任する。
  $('wordsTableBody').addEventListener('click', (e) => {
    const btn = e.target.closest('.row-edit-link');
    if (btn) openWordEditFromTable(Number(btn.dataset.id), btn.dataset.displayno);
  });
  $('wordsTableBody').addEventListener('change', (e) => {
    const cb = e.target.closest('.row-select');
    if (!cb) return;
    const id = Number(cb.dataset.id);
    if (cb.checked) selectedWordIds.add(id);
    else selectedWordIds.delete(id);
    updateWordsTableDeleteBtn();
    const all = [...document.querySelectorAll('#wordsTableBody .row-select')];
    $('wordsTableSelectAll').checked = all.length > 0 && all.every(c => c.checked);
  });
  $('wordsTableSelectAll').addEventListener('change', (e) => {
    const checked = e.target.checked;
    document.querySelectorAll('#wordsTableBody .row-select').forEach(cb => {
      cb.checked = checked;
      const id = Number(cb.dataset.id);
      if (checked) selectedWordIds.add(id);
      else selectedWordIds.delete(id);
    });
    updateWordsTableDeleteBtn();
  });
  $('wordsTableDeleteBtn').addEventListener('click', deleteSelectedWords);

  $('wordEditBackBtn').addEventListener('click', () => {
    showScreen('wordsTableView');
    loadWordsTablePage(wordsTablePage);
  });
  $('wordEditCancelBtn').addEventListener('click', () => {
    showScreen('wordsTableView');
    loadWordsTablePage(wordsTablePage);
  });
  $('wordEditSaveBtn').addEventListener('click', saveWordEditFromTable);
  $('wordEditAiRequestBtn').addEventListener('click', requestAiNoteForEdit);

  // ---- 更改メモ ----

  $('goNotesBtn').addEventListener('click', () => {
    editingNoteId = null;
    renderNotesList();
    showScreen('notes');
  });
  $('notesBackBtn').addEventListener('click', () => renderHome());
  $('notesAddBtn').addEventListener('click', submitNewNote);
  $('waeiBackToTopBtn').addEventListener('click', () => renderHome());
  $('waeiManageBtn').addEventListener('click', () => renderWaeiForm());
  $('waeiFormBackBtn').addEventListener('click', () => renderWaeiHome());

  $('waeiStartAllBtn').addEventListener('click', () => {
    if ($('waeiStartAllBtn').disabled) return;
    const existing = loadWaeiSession();
    if (existing && existing.currentIndex < existing.items.length) {
      if (!confirm('進行中のテストがあります。新しく始めると進捗は失われます。続けますか？')) return;
    }
    clearWaeiSession();
    startWaeiQuiz(expressions.length);
  });

  $('waeiCustomStartBtn').addEventListener('click', () => {
    if ($('waeiCustomStartBtn').disabled) return;
    const existing = loadWaeiSession();
    if (existing && existing.currentIndex < existing.items.length) {
      if (!confirm('進行中のテストがあります。新しく始めると進捗は失われます。続けますか？')) return;
    }
    const n = Math.max(1, parseInt($('waeiCustomX').value) || 10);
    clearWaeiSession();
    startWaeiQuiz(n);
  });

  $('waeiResumeBtn').addEventListener('click', () => {
    const s = loadWaeiSession();
    if (s) renderWaeiQuiz();
  });

  $('waeiQuizBackBtn').addEventListener('click', () => {
    if (confirm('テストを中断しますか？\n進捗は自動保存されているので、ホームの「前回の続きから」でいつでも再開できます。')) {
      renderWaeiHome();
    }
  });

  $('waeiRevealBtn').addEventListener('click', waeiReveal);
  $('waeiCorrectBtn').addEventListener('click', () => waeiJudge(true));
  $('waeiWrongBtn').addEventListener('click', () => waeiJudge(false));

  $('waeiSaveItemBtn').addEventListener('click', async () => {
    const ja = $('waeiInputJa').value.trim();
    const en = $('waeiInputEn').value.trim();
    if (!ja || !en) {
      $('waeiFormError').textContent = '日本語と英語の両方を入力してください。';
      return;
    }
    try {
      if (waeiEditingId) {
        await updateWaeiItem(waeiEditingId, ja, en);
      } else {
        await addWaeiItem(ja, en);
      }
      resetWaeiForm();
      renderWaeiItemList();
    } catch (err) {
      $('waeiFormError').textContent = '保存に失敗しました: ' + err.message;
    }
  });

  $('waeiCancelEditBtn').addEventListener('click', resetWaeiForm);

  $('waeiNextRoundBtn').addEventListener('click', waeiNextRound);
  $('waeiHomeBtn').addEventListener('click', () => {
    const s = loadWaeiSession();
    if (s && s.wrongIds && s.wrongIds.length === 0 && s.currentIndex >= s.items.length) {
      clearWaeiSession();
    }
    renderWaeiHome();
  });

  // キーボードショートカット
  document.addEventListener('keydown', (e) => {
    if (!screens.quiz.hidden) {
      if (e.key === ' ' || e.key === 'Enter') {
        if (!$('revealBtn').hidden) { e.preventDefault(); reveal(); }
      } else if (e.key === 'o' || e.key === 'O' || e.key === 'ArrowRight') {
        if (!$('judgeButtons').hidden) { e.preventDefault(); judge(true); }
      } else if (e.key === 'x' || e.key === 'X' || e.key === 'ArrowLeft') {
        if (!$('judgeButtons').hidden) { e.preventDefault(); judge(false); }
      }
    } else if (!screens.waeiQuiz.hidden) {
      if (e.key === ' ' || e.key === 'Enter') {
        if (!$('waeiRevealBtn').hidden) { e.preventDefault(); waeiReveal(); }
      } else if (e.key === 'o' || e.key === 'O' || e.key === 'ArrowRight') {
        if (!$('waeiJudgeButtons').hidden) { e.preventDefault(); waeiJudge(true); }
      } else if (e.key === 'x' || e.key === 'X' || e.key === 'ArrowLeft') {
        if (!$('waeiJudgeButtons').hidden) { e.preventDefault(); waeiJudge(false); }
      }
    }
  });
}

// ---------- init ----------

async function init() {
  bindEvents();
  await refreshNotes(); // notes.json由来のため、Supabaseの接続状況に関わらず常に読み込む
  if (!window.SUPABASE_URL || window.SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    renderStatusBar('unconfigured');
    return;
  }
  try {
    await Promise.all([refreshWords(), refreshExpressions(), refreshLatestClears()]);
  } catch (err) {
    renderStatusBar('error', err.message);
    return;
  }
  // 初期データ取得中にユーザーが既に他の画面へ操作していた場合、ここで強制的に
  // ホームへ戻さない（その画面はそれぞれの「戻る」導線で改めてrenderHome()される）。
  if (currentScreenName === null) renderHome();
}

init();
