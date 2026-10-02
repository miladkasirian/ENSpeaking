/* EN Speaking: a file as the subject of the Conversation tab.
   Reads .md, .txt, .pdf and .docx in the browser (nothing is uploaded except to the AI you talk to),
   finds the chapters, and keeps the file until you tap Delete chat. */
'use strict';

let docState = null; // { name, text, chapters: [{ title, start, end }], chapter: index or null }

/* How much of the file each engine gets in its instructions (characters). */
const DOC_CAP = { gemini: 60000, realtime: 20000, chat: 40000 };

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script'); s.src = src; s.dataset.src = src;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load the file reader. Check the internet connection.'));
    document.head.appendChild(s);
  });
}

/* ---------- reading ---------- */
async function readDocFile(file) {
  const name = file.name; const ext = (name.split('.').pop() || '').toLowerCase();
  if (file.size > 30 * 1024 * 1024) throw new Error('This file is too big (over 30 MB).');
  if (ext === 'doc') throw new Error('Old Word files (.doc) cannot be read. In Word, save it as .docx and try again.');
  if (ext === 'docx') return readDocx(file, name);
  if (ext === 'pdf') return readPdf(file, name);
  if (['md', 'markdown', 'txt', 'text'].includes(ext) || /^text\//.test(file.type)) {
    const text = clean(await file.text());
    return { name, text, chapters: ext === 'md' || ext === 'markdown' ? mdChapters(text) : lineChapters(text) };
  }
  throw new Error('Use a .md, .txt, .pdf or .docx file.');
}
function clean(t) { return String(t).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }

async function readDocx(file, name) {
  await loadScriptOnce('vendor/mammoth.browser.min.js');
  const out = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const box = document.createElement('div'); box.innerHTML = out.value;
  // headings become chapters: the highest heading level that appears at least twice
  const blocks = []; let text = '';
  box.querySelectorAll('h1,h2,h3,h4,p,li,td,th').forEach((n) => {
    if (n.closest('li') && n.tagName !== 'LI') return;
    const t = n.textContent.replace(/\s+/g, ' ').trim(); if (!t) return;
    const lvl = /^H[1-4]$/.test(n.tagName) ? Number(n.tagName[1]) : 0;
    blocks.push({ lvl, title: t, start: text.length }); text += t + '\n';
  });
  let chapters = [];
  for (const lvl of [1, 2, 3, 4]) {
    const hs = blocks.filter((b) => b.lvl === lvl);
    if (hs.length >= 2) { chapters = hs.map((h) => ({ title: h.title.slice(0, 120), start: h.start })); break; }
  }
  if (chapters.length < 2) chapters = lineChapters(text);
  return { name, text: clean(text), chapters: finishChapters(chapters, clean(text)) };
}

async function readPdf(file, name) {
  await loadScriptOnce('vendor/pdf.min.js');
  const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i); const tc = await page.getTextContent();
    let line = '';
    tc.items.forEach((it) => { line += it.str; if (it.hasEOL) { text += line + '\n'; line = ''; } else if (it.str && !/\s$/.test(it.str)) line += ' '; });
    text += line + '\n\n';
  }
  text = clean(text.replace(/ +/g, ' '));
  if (text.length < 20) throw new Error('No text found in this PDF. It may be scanned pages (pictures), which cannot be read.');
  return { name, text, chapters: lineChapters(text) };
}

/* ---------- chapters ---------- */
function mdChapters(text) {
  const lines = []; let pos = 0;
  text.split('\n').forEach((l) => { const m = l.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/); if (m) lines.push({ lvl: m[1].length, title: m[2], start: pos }); pos += l.length + 1; });
  for (const lvl of [1, 2, 3, 4]) {
    const hs = lines.filter((h) => h.lvl === lvl);
    if (hs.length >= 2) return finishChapters(hs, text);
  }
  return lineChapters(text);
}
const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const CHAPTER_LINE = new RegExp('^\\s*(chapter|unit|lesson|part|module|section|فصل|درس|بخش)\\s*[:.\\-]?\\s*([0-9]+|[ivxlc]+|[۰-۹]+|' + NUM_WORDS.slice(1).join('|') + ')\\b.{0,100}$', 'i');
/* Lines like "Chapter 3 ...", "Unit 2: ...", "فصل ۴". A table of contents repeats them, so for each
   chapter number the occurrence with the longest text after it is kept. */
function lineChapters(text) {
  const found = []; let pos = 0;
  text.split('\n').forEach((l) => {
    const m = l.trim().length <= 120 && l.match(CHAPTER_LINE);
    if (m) found.push({ title: l.trim(), start: pos, key: (m[1] + ' ' + chapterNumber(m[2])).toLowerCase() });
    pos += l.length + 1;
  });
  if (found.length < 2) return [];
  found.forEach((f, i) => { f.len = (i + 1 < found.length ? found[i + 1].start : text.length) - f.start; });
  const best = {};
  found.forEach((f) => { if (!best[f.key] || f.len > best[f.key].len) best[f.key] = f; });
  const list = Object.values(best).sort((a, b) => a.start - b.start);
  return list.length >= 2 ? finishChapters(list, text) : [];
}
function chapterNumber(s) {
  s = String(s).toLowerCase().replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  if (/^\d+$/.test(s)) return Number(s);
  const w = NUM_WORDS.indexOf(s); if (w > 0) return w;
  const R = { i: 1, v: 5, x: 10, l: 50, c: 100 }; let n = 0;
  for (let i = 0; i < s.length; i++) { const a = R[s[i]], b = R[s[i + 1]] || 0; if (!a) return s; n += a < b ? -a : a; }
  return n;
}
function finishChapters(list, text) {
  const out = list.map((c, i) => ({ title: c.title.replace(/\s+/g, ' ').trim().slice(0, 120), start: c.start, end: i + 1 < list.length ? list[i + 1].start : text.length }));
  return out.filter((c) => c.end - c.start > 40).length >= 2 ? out : [];
}
function chapterText(i) { const c = docState.chapters[i]; return docState.text.slice(c.start, c.end).trim(); }

/* ---------- what the AI gets ---------- */
function docEngine() { return rt ? 'realtime' : gl ? 'gemini' : (S.engine === 'realtime' ? 'realtime' : S.engine === 'glive' ? 'gemini' : 'chat'); }
function docActive() { return !!docState && mode === 'talk'; }
function docCut(text, cap) { return text.length <= cap ? { body: text, cut: false } : { body: text.slice(0, cap), cut: true }; }
function docOutline() {
  return docState.chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
}
/* The opening move with a file. */
function docOpening() {
  const d = docState; const t = $('topic').value.trim();
  const focus = t ? ` The learner also wrote this focus: ${t}.` : '';
  if (d.chapters.length && d.chapter == null) {
    return `The learner gave you a document called "${d.name}". It has these chapters:\n${docOutline()}\nAt the very start, greet the learner briefly and ask which chapter they want to talk about (you may name two or three). When they choose, talk only about that chapter: ask about its content and ideas and help them talk about it in their own words.${focus}`;
  }
  if (d.chapter != null) return `The learner chose the chapter "${d.chapters[d.chapter].title}" of their document "${d.name}". Start right away with a friendly question about it. Talk only about this chapter.${focus}`;
  return `The learner gave you a document called "${d.name}". At the very start, greet the learner briefly and ask what part or topic of the document they want to talk about, suggesting two or three topics from it. Then keep the conversation on the document.${focus}`;
}
/* The document itself, added by the code to the instructions of every Conversation engine. */
function docBlock(engine = docEngine()) {
  if (!docActive()) return '';
  const d = docState; const cap = DOC_CAP[engine] || DOC_CAP.chat;
  let head; let src;
  if (d.chapter != null) {
    src = chapterText(d.chapter);
    head = `The learner chose this chapter: "${d.chapters[d.chapter].title}". Talk ONLY about this chapter. Do not bring up other chapters unless the learner asks to switch.`;
  } else {
    src = d.text;
    head = d.chapters.length ? `Chapters in the document:\n${docOutline()}\nOnce the learner picks a chapter, talk only about that chapter.` : '';
  }
  const { body, cut } = docCut(src, cap);
  return `\n\nTHE LEARNER'S DOCUMENT "${d.name}". It is the subject of this whole conversation: stay on it and never drift to other topics, unless the learner clearly asks.` +
    (head ? '\n' + head : '') +
    (cut ? '\n(Only the beginning is shown below because it is long. If the learner asks about a part you cannot see, say so briefly and ask them to tell you about it.)' : '') +
    `\n--- DOCUMENT START ---\n${body}\n--- DOCUMENT END ---`;
}
/* Your words picked a chapter ("chapter three", "unit 2", or its title): focus on it. */
function docHeard(text) {
  if (!docActive() || !docState.chapters.length || docState.chapter != null) return;
  const low = String(text).toLowerCase();
  let pick = -1;
  const m = low.match(new RegExp('\\b(?:chapter|unit|lesson|part|module|section)\\s+(\\d+|' + NUM_WORDS.slice(1).join('|') + ')\\b')) ||
    low.match(new RegExp('\\b(?:the\\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+(?:chapter|unit|lesson|part)'));
  if (m) {
    const ord = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].indexOf(m[1]);
    const n = ord >= 0 ? ord + 1 : chapterNumber(m[1]);
    pick = docState.chapters.findIndex((c) => { const cm = c.title.match(CHAPTER_LINE); return cm && chapterNumber(cm[2]) === n; });
    if (pick < 0 && n >= 1 && n <= docState.chapters.length) pick = n - 1;
  } else {
    const said = new Set(words(text).filter((w) => w.length > 3));
    let best = 0;
    docState.chapters.forEach((c, i) => {
      const tw = words(c.title.replace(CHAPTER_LINE, (x) => x.replace(/^\s*\S+\s*\S+/, ''))).filter((w) => w.length > 3);
      if (!tw.length) return;
      const score = tw.filter((w) => said.has(w)).length / tw.length;
      if (score >= 0.6 && score > best) { best = score; pick = i; }
    });
  }
  if (pick >= 0) setDocChapter(pick, 'voice');
}

/* ---------- state, storage and the bar under Topic ---------- */
function saveDoc() {
  try {
    if (docState) localStorage.setItem('ens.doc', JSON.stringify(docState)); else localStorage.removeItem('ens.doc');
    return true;
  } catch { try { localStorage.removeItem('ens.doc'); } catch { /* ignore */ } return false; }
}
function setDocChapter(i, from) {
  if (!docState) return;
  const prev = docState.chapter;
  docState.chapter = i == null || i === '' || i < 0 ? null : Number(i);
  if (prev === docState.chapter) return;
  saveDoc(); renderDocBar();
  if (!(rt || gl)) return;
  const engine = docEngine();
  const full = docState.text.length > DOC_CAP[engine];
  // by voice the partner already heard the choice; the call is refreshed only if it could not see that chapter
  if (from === 'voice' && !full) return;
  const c = docState.chapter != null ? docState.chapters[docState.chapter].title : null;
  liveSettingsChanged(c ? `Let's talk about the chapter "${c}" now. Ask me a question about it.` : "Let's talk about the whole document. Ask me which part I want to talk about.");
}
function renderDocBar() {
  const bar = $('docBar'); if (!bar) return;
  const d = docState;
  bar.hidden = !d || mode !== 'talk';
  $('docBtn').classList.toggle('on', !!d);
  if (!d) return;
  $('docName').textContent = d.name;
  const sel = $('docChapter');
  sel.hidden = !d.chapters.length;
  sel.innerHTML = '<option value="">All chapters (AI asks)</option>' + d.chapters.map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join('');
  sel.value = d.chapter == null ? '' : String(d.chapter);
}
function clearDoc() { docState = null; saveDoc(); renderDocBar(); }
async function onDocPicked(file) {
  if (!file) return;
  setStatus('Reading ' + file.name + '...');
  try {
    const d = await readDocFile(file);
    d.chapter = null; docState = d;
    const kept = saveDoc();
    renderDocBar();
    const parts = d.chapters.length ? `${d.chapters.length} chapters found` : 'no chapters found';
    setStatus(`${d.name}: ${parts}. ` + (kept ? 'It stays until you tap Delete chat.' : 'It is too big to keep after the app closes.'));
    if (rt || gl) liveSettingsChanged(d.chapters.length ? 'I gave you a document. Ask me which chapter I want to talk about.' : 'I gave you a document. Ask me what part of it I want to talk about.');
  } catch (e) { setStatus(e.message || 'Could not read this file.', true); }
}
function setupDoc() {
  docState = store.get('ens.doc', null);
  if (docState && (!docState.text || !Array.isArray(docState.chapters))) docState = null;
  $('docBtn').addEventListener('click', () => { $('docFile').value = ''; $('docFile').click(); });
  $('docFile').addEventListener('change', () => onDocPicked($('docFile').files[0]));
  $('docChapter').addEventListener('change', () => setDocChapter($('docChapter').value, 'menu'));
  renderDocBar();
}
