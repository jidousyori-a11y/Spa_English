import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const LS_SESSION = 'eiwq.session.v1';
const LS_CUSTOM = 'eiwq.custom.v1';
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
};

function showScreen(name) {
  for (const k of Object.keys(screens)) {
    screens[k].hidden = (k !== name);
  }
}

// ---------- Supabaseデータ（words / expressions） ----------

let words = [];
let expressions = [];

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

function loadCustomSettings() {
  try { return JSON.parse(localStorage.getItem(LS_CUSTOM)) || { x: 15, y: 5000 }; }
  catch { return { x: 15, y: 5000 }; }
}
function saveCustomSettings(x, y) { localStorage.setItem(LS_CUSTOM, JSON.stringify({ x, y })); }

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
const MARKER_LABELS = { t: 'Tips' };

function pickWords(allWords, mode, latestAddedCount) {
  let pool;
  let label;
  let quizSize = QUIZ_SIZE;
  if (mode.startsWith('marker:')) {
    const marker = mode.slice('marker:'.length);
    pool = allWords.filter(w => w.marker === marker);
    label = `${MARKER_LABELS[marker] || marker}単語`;
    const n = Math.min(quizSize, pool.length);
    return { words: shuffle(pool).slice(0, n), label };
  }
  switch (mode) {
    case 'latest50': {
      const n = Math.max(1, latestAddedCount || 50);
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
  const container = $('markerButtons');
  container.innerHTML = '';
  const markers = [...new Set(words.map(w => w.marker).filter(Boolean))].sort();
  for (const marker of markers) {
    const count = words.filter(w => w.marker === marker).length;
    const btn = document.createElement('button');
    btn.className = 'mode-btn';
    btn.dataset.mode = `marker:${marker}`;
    btn.textContent = `${MARKER_LABELS[marker] || marker}単語のみ（${count}個から）`;
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const existing = loadSession();
      if (existing && existing.currentIndex < existing.words.length) {
        if (!confirm('進行中のクイズがあります。新しく始めると進捗は失われます。続けますか？')) return;
      }
      clearSession();
      startNewSession(btn.dataset.mode);
    });
    container.appendChild(btn);
  }
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
      $('lastImportText').textContent = 'Supabase上のデータを表示しています。';
    }
    const latestN = Math.max(1, (meta && meta.latestAddedCount) || 50);
    $('latest50Btn').textContent = `Latest単語(${latestN}個)`;
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

  const resumeBtn = $('resumeBtn');
  if (session && session.words && session.currentIndex < session.words.length) {
    resumeBtn.hidden = false;
    resumeBtn.textContent = `前回の続きから（${session.modeLabel} / ${session.round}周目 ${session.currentIndex + 1}/${session.words.length}）`;
  } else {
    resumeBtn.hidden = true;
  }

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
  } else {
    $('japaneseWord').hidden = true;
    $('revealBtn').hidden = false;
    $('judgeButtons').hidden = true;
    $('aiExampleBox').hidden = true;
  }

  const aiBtn = $('aiExampleBtn');
  const aiResult = $('aiExampleResult');
  aiBtn.hidden = false;
  aiBtn.disabled = false;
  aiBtn.textContent = '✨ 例文をAIにリクエスト';
  aiResult.hidden = true;
  aiResult.textContent = '';

  showScreen('quiz');
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
  } catch (err) {
    const hint = key
      ? '（保存されているAPIキーが正しいか、ホーム画面の「AI機能のAPIキー設定」から確認してください）'
      : '（この機能は node server.js でローカルサーバーを起動しているか、ホーム画面の「AI機能のAPIキー設定」でGemini APIキーを登録している場合のみ利用できます）';
    const msg = 'AI例文の取得に失敗しました: ' + err.message + '\n' + hint;
    resultEl.innerHTML = escapeHtml(msg).replace(/\n/g, '<br>');
    resultEl.hidden = false;
    btn.disabled = false;
    btn.textContent = '✨ 例文をAIにリクエスト';
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
      const existing = loadSession();
      if (existing && existing.currentIndex < existing.words.length) {
        if (!confirm('進行中のクイズがあります。新しく始めると進捗は失われます。続けますか？')) return;
      }
      clearSession();
      startNewSession(mode);
    });
  });

  $('resumeBtn').addEventListener('click', () => {
    const s = loadSession();
    if (s) renderQuiz();
  });

  $('backBtn').addEventListener('click', () => {
    if (confirm('クイズを中断しますか？\n進捗は自動保存されているので、ホームの「前回の続きから」でいつでも再開できます。')) {
      renderHome();
    }
  });

  $('revealBtn').addEventListener('click', reveal);
  $('aiExampleBtn').addEventListener('click', requestAiExamples);
  $('correctBtn').addEventListener('click', () => judge(true));
  $('wrongBtn').addEventListener('click', () => judge(false));

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
  if (!window.SUPABASE_URL || window.SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    renderStatusBar('unconfigured');
    return;
  }
  try {
    await Promise.all([refreshWords(), refreshExpressions()]);
  } catch (err) {
    renderStatusBar('error', err.message);
    return;
  }
  renderHome();
}

init();
