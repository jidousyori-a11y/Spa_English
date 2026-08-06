'use strict';
// ローカル専用サーバー。
// 静的ファイル（index.html / app.js / style.css など）を配信しつつ、
// POST /api/gemini-examples と /api/words・/api/expressions への書き込み系リクエストだけ
// サーバー側で処理する。
//
// - Gemini の API キーは環境変数 GEMINI_API_KEY からのみ読み取り、ブラウザには渡さない。
// - Supabaseへの書き込み(insert/update/delete)は環境変数 SUPABASE_SERVICE_ROLE_KEY
//   （RLSを無視できる管理者キー）を使ってこのサーバーが代行する。
//   公開されるブラウザ側(config.js)はRLSで読み取り専用に制限されたanonキーしか持たないため、
//   GitHub Pages等に公開してもこのサーバーが無い環境からは書き込みできない。

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10509;
const ROOT = __dirname;
const GEMINI_MODEL = 'gemini-2.5-flash';
const SUPABASE_URL = 'https://owuwhpfybfozzlovmehl.supabase.co';
const WORD_NOTE_PROMPT_FILE = path.join(ROOT, 'prompts', 'word-note.md');

// プロンプトはコードから切り離し、prompts/word-note.md から都度読み込む
// (サーバー再起動なしで文面を調整できる)。
function renderWordNotePrompt(vars) {
  const template = fs.readFileSync(WORD_NOTE_PROMPT_FILE, 'utf-8');
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(ROOT, rel));

  // ROOT の外に出るパス（ディレクトリトラバーサル）は拒否
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // 念のための上限
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// service_roleキーでSupabase REST(PostgREST)を叩く。RLSは常にバイパスされる。
async function supabaseServiceRequest(pathAndQuery, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    const err = new Error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    err.isConfigError = true;
    throw err;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1${pathAndQuery}`, {
    ...options,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message || `Supabase API エラー (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

function handleSupabaseError(res, err) {
  if (err.isConfigError) {
    sendJson(res, 500, { error: err.message });
    return;
  }
  sendJson(res, err.status || 502, { error: 'Supabaseへの書き込みに失敗しました: ' + err.message });
}

// POST /api/words/import  { rows: [{row, en, ja}, ...] } → words に一括insert
async function handleWordsImport(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストの形式が不正です。' });
    return;
  }
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const clean = rows
    .map(r => ({
      row: Number(r.row) || null,
      en: (r.en || '').toString(),
      ja: (r.ja || '').toString(),
      marker: r.marker ? r.marker.toString().trim() || null : null,
    }))
    .filter(r => r.en && r.ja);
  if (clean.length === 0) {
    sendJson(res, 400, { error: '追加する単語がありません。' });
    return;
  }
  try {
    // rowが未指定の行(Excel由来ではない直接登録など)には、既存の最大rowに続く連番を自動採番する。
    if (clean.some(r => r.row === null)) {
      const maxRowData = await supabaseServiceRequest('/words?select=row&order=row.desc.nullslast&limit=1');
      let nextRow = (maxRowData[0] && maxRowData[0].row ? maxRowData[0].row : 0) + 1;
      for (const r of clean) {
        if (r.row === null) {
          r.row = nextRow;
          nextRow += 1;
        }
      }
    }
    const data = await supabaseServiceRequest('/words', {
      method: 'POST',
      body: JSON.stringify(clean),
    });
    sendJson(res, 200, { inserted: data.length });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// POST /api/expressions  { ja, en } → expressions に1件insert
async function handleExpressionsCreate(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストの形式が不正です。' });
    return;
  }
  const ja = (payload.ja || '').toString().trim();
  const en = (payload.en || '').toString().trim();
  if (!ja || !en) {
    sendJson(res, 400, { error: '日本語と英語の両方を入力してください。' });
    return;
  }
  try {
    const data = await supabaseServiceRequest('/expressions', {
      method: 'POST',
      body: JSON.stringify({ ja, en }),
    });
    sendJson(res, 200, { item: data[0] });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// PATCH /api/expressions/:id  { ja, en } → 1件update
async function handleExpressionsUpdate(req, res, id) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストの形式が不正です。' });
    return;
  }
  const ja = (payload.ja || '').toString().trim();
  const en = (payload.en || '').toString().trim();
  if (!ja || !en) {
    sendJson(res, 400, { error: '日本語と英語の両方を入力してください。' });
    return;
  }
  try {
    const data = await supabaseServiceRequest(`/expressions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ja, en }),
    });
    sendJson(res, 200, { item: data[0] });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// PATCH /api/words/:id  { en, ja, ai_note } → クイズ中の編集用。en/jaは必須、ai_noteは
// 空文字を渡せば削除できる(null/undefinedの場合のみ更新しない＝キー自体を省略する)。
async function handleWordsUpdate(req, res, id) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストの形式が不正です。' });
    return;
  }
  const en = (payload.en ?? '').toString().trim();
  const ja = (payload.ja ?? '').toString().trim();
  if (!en || !ja) {
    sendJson(res, 400, { error: '英語と日本語の両方を入力してください。' });
    return;
  }
  const body = { en, ja };
  if (typeof payload.ai_note === 'string') {
    body.ai_note = payload.ai_note.trim() || null;
  }
  if (typeof payload.marker === 'string') {
    body.marker = payload.marker.trim() || null;
  }
  try {
    const data = await supabaseServiceRequest(`/words?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    sendJson(res, 200, { item: data[0] });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// PATCH /api/words/:id/ai-note  { note } → 1件のwords.ai_noteを更新
async function handleWordsAiNoteUpdate(req, res, id) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストの形式が不正です。' });
    return;
  }
  const note = (payload.note || '').toString().trim();
  if (!note) {
    sendJson(res, 400, { error: '保存する内容がありません。' });
    return;
  }
  try {
    const data = await supabaseServiceRequest(`/words?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ai_note: note }),
    });
    sendJson(res, 200, { item: data[0] });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// DELETE /api/expressions/:id
async function handleExpressionsDelete(req, res, id) {
  try {
    await supabaseServiceRequest(`/expressions?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// ---------- 更改メモ(notes) ----------
// words/expressionsとは完全に独立。同じread-only anon + service_role書き込みパターン。

// POST /api/notes  { text } → notes に1件insert
async function handleNotesCreate(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストの形式が不正です。' });
    return;
  }
  const text = (payload.text || '').toString().trim();
  if (!text) {
    sendJson(res, 400, { error: 'メモを入力してください。' });
    return;
  }
  try {
    const data = await supabaseServiceRequest('/notes', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    sendJson(res, 200, { item: data[0] });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// PATCH /api/notes/:id  { text } → 1件update
async function handleNotesUpdate(req, res, id) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストの形式が不正です。' });
    return;
  }
  const text = (payload.text || '').toString().trim();
  if (!text) {
    sendJson(res, 400, { error: 'メモを入力してください。' });
    return;
  }
  try {
    const data = await supabaseServiceRequest(`/notes?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    });
    sendJson(res, 200, { item: data[0] });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

// DELETE /api/notes/:id
async function handleNotesDelete(req, res, id) {
  try {
    await supabaseServiceRequest(`/notes?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    handleSupabaseError(res, err);
  }
}

async function handleGeminiExamples(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '環境変数 GEMINI_API_KEY が設定されていません。' }));
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'リクエストの形式が不正です。' }));
    return;
  }

  const en = (payload.en || '').toString().trim();
  const ja = (payload.ja || '').toString().trim();
  if (!en || !ja) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '単語情報が不足しています。' }));
    return;
  }

  let prompt;
  try {
    prompt = renderWordNotePrompt({ en, ja });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'プロンプトファイルの読み込みに失敗しました: ' + e.message }));
    return;
  }

  try {
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const data = await apiRes.json();

    if (!apiRes.ok) {
      const message = data?.error?.message || `Gemini API エラー (HTTP ${apiRes.status})`;
      res.writeHead(apiRes.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
      return;
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Gemini から有効な応答が得られませんでした。' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ text }));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Gemini API への接続に失敗しました: ' + e.message }));
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const expressionMatch = urlPath.match(/^\/api\/expressions\/([^/]+)$/);
  const wordAiNoteMatch = urlPath.match(/^\/api\/words\/([^/]+)\/ai-note$/);
  const wordMatch = urlPath.match(/^\/api\/words\/([^/]+)$/);
  const noteMatch = urlPath.match(/^\/api\/notes\/([^/]+)$/);

  if (req.method === 'POST' && urlPath === '/api/gemini-examples') {
    handleGeminiExamples(req, res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/words/import') {
    handleWordsImport(req, res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/expressions') {
    handleExpressionsCreate(req, res);
    return;
  }
  if (req.method === 'PATCH' && expressionMatch) {
    handleExpressionsUpdate(req, res, decodeURIComponent(expressionMatch[1]));
    return;
  }
  if (req.method === 'PATCH' && wordAiNoteMatch) {
    handleWordsAiNoteUpdate(req, res, decodeURIComponent(wordAiNoteMatch[1]));
    return;
  }
  if (req.method === 'PATCH' && wordMatch) {
    handleWordsUpdate(req, res, decodeURIComponent(wordMatch[1]));
    return;
  }
  if (req.method === 'DELETE' && expressionMatch) {
    handleExpressionsDelete(req, res, decodeURIComponent(expressionMatch[1]));
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/notes') {
    handleNotesCreate(req, res);
    return;
  }
  if (req.method === 'PATCH' && noteMatch) {
    handleNotesUpdate(req, res, decodeURIComponent(noteMatch[1]));
    return;
  }
  if (req.method === 'DELETE' && noteMatch) {
    handleNotesDelete(req, res, decodeURIComponent(noteMatch[1]));
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  const keyStatus = process.env.GEMINI_API_KEY ? '検出済み' : '未設定（例文リクエスト機能は使えません）';
  console.log(`英単語クイズ(Supabaseテスト): http://localhost:${PORT} で起動しました`);
  console.log(`GEMINI_API_KEY: ${keyStatus}`);
});
