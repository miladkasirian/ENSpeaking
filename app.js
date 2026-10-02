/* EN Speaking - spoken English practice with OpenAI.
   Flow per turn: record (MediaRecorder) -> speech-to-text -> chat model (JSON) -> voice.
   The API key lives only in this device's localStorage. */
'use strict';

const VERSION = '1.0.0 (2026-10-02)';
const API = 'https://api.openai.com/v1';

const DEFAULTS = {
  level: 'B1', strict: 'all', explainLang: 'English', replyLen: 'short',
  sayCorrections: true, autoStop: true, handsFree: false,
  voiceEngine: 'device', deviceVoice: '', openaiVoice: 'coral', rate: 1,
  chatModel: 'gpt-4o-mini', sttModel: 'gpt-4o-mini-transcribe', ttsModel: 'gpt-4o-mini-tts',
  pSTT: 0.003, pIn: 0.15, pOut: 0.60, pTTS: 0.015,
};
const ADV_KEYS = ['chatModel', 'sttModel', 'ttsModel', 'pSTT', 'pIn', 'pOut', 'pTTS'];

/* ---------- storage (may be unavailable, so always guarded) ---------- */
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const S = Object.assign({}, DEFAULTS, store.get('ens.settings', {}));
let apiKey = store.get('ens.key', '');
const totals = Object.assign({ stt: 0, chat: 0, tts: 0 }, store.get('ens.totals', {}));
let sessionCost = 0;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html !== undefined) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- state ---------- */
let mode = 'talk';            // 'talk' | 'repeat'
let phase = 'idle';           // 'idle' | 'rec' | 'think' | 'speak'
let history = [];             // conversation turns for the chat model
let lastSpoken = '';
let target = null;            // { sentence, focus }
let usedSentences = store.get('ens.used', []);
let attempts = 0;
let hideText = false;
let handsFreeCancelled = false;

/* ---------- UI helpers ---------- */
function setStatus(text, isErr = false) {
  const s = $('status'); s.textContent = text; s.classList.toggle('err', isErr);
}
function setPhase(p) {
  phase = p;
  const mic = $('mic');
  mic.classList.toggle('rec', p === 'rec');
  mic.classList.toggle('busy', p === 'think');
  mic.setAttribute('aria-label', p === 'rec' ? 'Stop and send' : 'Start speaking');
  if (p !== 'rec') mic.style.setProperty('--lvl', 0);
}
function addCost(kind, usd) {
  if (!isFinite(usd) || usd <= 0) return;
  sessionCost += usd;
  totals[kind] += usd;
  store.set('ens.totals', totals);
  $('cost').textContent = '$' + sessionCost.toFixed(sessionCost < 0.1 ? 4 : 3);
}
function renderTotals() {
  const all = totals.stt + totals.chat + totals.tts;
  $('totals').innerHTML = `Estimated spend on this device: <b>$${all.toFixed(4)}</b><br>` +
    `Speech-to-text $${totals.stt.toFixed(3)} · Chat $${totals.chat.toFixed(3)} · OpenAI voice $${totals.tts.toFixed(3)}`;
}
function scrollDown(log) { requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); }
function emptyState() {
  const log = $('log');
  if (!log.children.length) {
    log.appendChild(el('div', 'empty',
      'Tap the mic and say hello.<br>Your words appear <b>exactly as heard</b>, with corrections underneath.'));
  }
  const rlog = $('repeatLog');
  if (!rlog.children.length) {
    rlog.appendChild(el('div', 'empty',
      'Listen, then tap the mic and repeat.<br>The check compares <b>words</b>, not accent.'));
  }
}
function clearEmpty(log) { log.querySelectorAll('.empty').forEach((n) => n.remove()); }

/* ---------- OpenAI calls ---------- */
async function apiError(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch { /* ignore */ }
  if (res.status === 401) return new Error('The API key was rejected. Check it in Settings.');
  if (res.status === 429) return new Error('OpenAI says: too many requests or no credit left. ' + msg);
  if (res.status === 404 || /model/i.test(msg)) return new Error(msg + ' (You can change the model in Settings > Advanced.)');
  return new Error(msg);
}

async function transcribe(blob, ext, seconds) {
  const fd = new FormData();
  fd.append('file', blob, 'speech.' + ext);
  fd.append('model', S.sttModel);
  fd.append('language', 'en');
  fd.append('response_format', 'json');
  fd.append('prompt', 'Transcribe exactly what the speaker says, word for word. The speaker is learning English. ' +
    'Keep every grammar mistake, wrong verb form, missing or wrong article, wrong word, false start and filler word. ' +
    'Do not correct or improve anything.');
  const res = await fetch(API + '/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: fd,
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  addCost('stt', (seconds / 60) * Number(S.pSTT));
  return (j.text || '').trim();
}

async function chatJSON(messages, maxTokens = 500) {
  const res = await fetch(API + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: S.chatModel, messages,
      response_format: { type: 'json_object' },
      max_completion_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const u = j.usage || {};
  addCost('chat', ((u.prompt_tokens || 0) * Number(S.pIn) + (u.completion_tokens || 0) * Number(S.pOut)) / 1e6);
  const txt = j.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(txt); } catch { throw new Error('The model returned an unreadable answer. Try again.'); }
}

/* ---------- voice output ---------- */
const audioEl = new Audio();
audioEl.preload = 'auto';
let audioUnlocked = false;
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function unlockAudio() {
  // iOS only lets a page play sound after a tap; do one silent play inside the tap.
  if (audioUnlocked) return;
  audioUnlocked = true;
  try { audioEl.src = SILENT_WAV; audioEl.play().catch(() => {}); } catch { /* ignore */ }
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; speechSynthesis.speak(u);
    }
  } catch { /* ignore */ }
}

function englishVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang) || v.lang === 'en');
}
function pickVoice() {
  const vs = englishVoices();
  return vs.find((v) => v.voiceURI === S.deviceVoice) ||
    vs.find((v) => /premium|enhanced/i.test(v.name) && /en-US/i.test(v.lang)) ||
    vs.find((v) => /samantha|ava|allison|karen|daniel/i.test(v.name)) ||
    vs.find((v) => /en-US/i.test(v.lang)) || vs[0] || null;
}
function fillVoices() {
  const sel = $('deviceVoice');
  const vs = englishVoices();
  const chosen = pickVoice();
  sel.innerHTML = '';
  vs.forEach((v) => {
    const o = el('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
    if (chosen && v.voiceURI === chosen.voiceURI) o.selected = true;
    sel.appendChild(o);
  });
  if (!vs.length) { const o = el('option'); o.textContent = 'No English voice found'; sel.appendChild(o); }
}

function stopSpeaking() {
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  try { audioEl.pause(); } catch { /* ignore */ }
}

function speakDevice(text, rate) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
    u.rate = rate;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    // Safari sometimes never fires onend; fall back to a length-based timer.
    const t = setTimeout(finish, 2500 + (text.length * 85) / rate);
    u.onend = finish; u.onerror = finish;
    speechSynthesis.speak(u);
  });
}

async function speakOpenAI(text, rate) {
  const res = await fetch(API + '/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: S.ttsModel, voice: S.openaiVoice, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) throw await apiError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(); } };
    audioEl.onended = finish; audioEl.onerror = finish; audioEl.onpause = () => { if (audioEl.src === url) finish(); };
    audioEl.onloadedmetadata = () => {
      if (isFinite(audioEl.duration)) addCost('tts', (audioEl.duration / 60) * Number(S.pTTS));
    };
    audioEl.src = url;
    audioEl.playbackRate = rate;
    audioEl.play().catch(() => { setStatus('Tap the replay button to hear the answer.'); finish(); });
  });
}

async function speak(text, rate = Number(S.rate)) {
  if (!text) return;
  lastSpoken = text;
  $('replay').disabled = false;
  setPhase('speak');
  setStatus('Speaking... (tap the mic to interrupt)');
  try {
    if (S.voiceEngine === 'openai') await speakOpenAI(text, rate);
    else await speakDevice(text, rate);
  } catch (e) {
    setStatus(e.message + ' Using the iPhone voice instead.', true);
    await speakDevice(text, rate);
  }
  if (phase === 'speak') { setPhase('idle'); setStatus('Tap the mic and speak.'); }
}

/* ---------- recording ---------- */
let audioCtx = null;
let rec = null;

function pickMime() {
  if (!window.MediaRecorder) return null;
  const opts = [['audio/mp4', 'mp4'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']];
  for (const [m, ext] of opts) { if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext }; }
  return { mime: '', ext: 'webm' };
}

async function startRec() {
  if (!apiKey) { setStatus('Add your OpenAI key first.', true); openSettings(); return; }
  const fmt = pickMime();
  if (!fmt || !navigator.mediaDevices?.getUserMedia) { setStatus('This browser cannot record audio.', true); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    setStatus(e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in Safari settings, then tap the mic.' : 'Microphone error: ' + e.message, true);
    setPhase('idle');
    return;
  }

  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch { audioCtx = null; }

  const chunks = [];
  const mr = new MediaRecorder(stream, fmt.mime ? { mimeType: fmt.mime } : undefined);
  const r = { mr, stream, chunks, ext: fmt.ext, mime: mr.mimeType || fmt.mime, t0: performance.now(), heard: false, stopped: false };
  rec = r;
  mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  mr.onstop = () => onRecorded(r);
  mr.start();
  setPhase('rec');
  setStatus(S.autoStop ? 'Listening... (I stop when you go quiet)' : 'Listening... tap again when you finish.');

  // Level meter and silence detection.
  if (audioCtx) {
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser(); an.fftSize = 1024;
    src.connect(an);
    r.src = src;
    const buf = new Float32Array(an.fftSize);
    let floor = 0, nFloor = 0, lastLoud = performance.now();
    const tick = () => {
      if (r.stopped) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      const el_ = now - r.t0;
      if (el_ < 300) { floor += rms; nFloor++; }
      const thr = Math.max(0.012, (nFloor ? floor / nFloor : 0) * 2.5);
      if (rms > thr) { r.heard = true; lastLoud = now; }
      $('mic').style.setProperty('--lvl', Math.min(1, rms * 12).toFixed(2));
      if (S.autoStop && r.heard && now - lastLoud > 1400) return stopRec();
      if (S.autoStop && !r.heard && el_ > 9000) return stopRec();
      if (el_ > 90000) return stopRec();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } else {
    r.heard = true; // cannot measure, assume speech
  }
}

function stopRec() {
  const r = rec; if (!r || r.stopped) return;
  r.stopped = true;
  r.t1 = performance.now();
  try { r.mr.stop(); } catch { /* ignore */ }
  // Release the mic right away: on iPhone an open mic makes speech output quiet.
  r.stream.getTracks().forEach((t) => t.stop());
  try { r.src && r.src.disconnect(); } catch { /* ignore */ }
  setPhase('think');
  setStatus('Thinking...');
}

async function onRecorded(r) {
  rec = null;
  const seconds = Math.max(0.1, ((r.t1 || performance.now()) - r.t0) / 1000);
  const blob = new Blob(r.chunks, { type: r.mime || 'audio/mp4' });
  if (!r.heard || blob.size < 1000) {
    setPhase('idle');
    setStatus("I didn't hear anything. Tap the mic to try again.");
    return;
  }
  try {
    const text = await transcribe(blob, r.ext, seconds);
    if (!text) { setPhase('idle'); setStatus("I couldn't make out any words. Try again."); return; }
    if (mode === 'talk') await handleTalk(text);
    else await handleRepeat(text);
  } catch (e) {
    setPhase('idle');
    setStatus(e.message, true);
  }
}

/* ---------- conversation mode ---------- */
function talkSystemPrompt() {
  const strictRule = {
    all: 'Report every grammar, word-choice and unnatural-phrasing mistake.',
    major: 'Report only clear grammar mistakes and wrong words that change or blur the meaning. Ignore small style issues.',
    off: 'Do not report mistakes: always return an empty "mistakes" list, an empty "corrected" and an empty "spoken_fix".',
  }[S.strict];
  const len = S.replyLen === 'short' ? '1 or 2 short sentences' : '2 to 4 sentences';
  const topic = $('topic').value.trim();
  return [
    `You are a warm, natural English conversation partner for an adult learner at CEFR level ${S.level}.`,
    'This is a spoken conversation. The learner\'s message is a speech-to-text transcript, so ignore punctuation, capitalization and spelling.',
    'If a word looks like a speech-recognition slip rather than the learner\'s own mistake, ignore it.',
    strictRule,
    `Then reply in English with ${len}, using vocabulary that fits ${S.level}. Keep the conversation going, usually with one question.`,
    'If the learner asks you to give them a sentence to repeat, give one sentence in "reply" and, on the next turn, compare what they said with it.',
    'If the learner asks a question about English, answer it briefly and clearly.',
    topic ? `Conversation topic: ${topic}.` : 'Let the learner choose the topic; if they have nothing to say, suggest an everyday topic.',
    `Write each "why" in ${S.explainLang}, in at most 12 words.`,
    'Return only a JSON object with exactly these keys:',
    '{"mistakes":[{"wrong":"the exact words they said","right":"the corrected words","why":"short reason"}],',
    '"corrected":"their whole message corrected and natural, or an empty string if there were no mistakes",',
    '"spoken_fix":"if there were mistakes, one very short spoken recast such as: You could say, I went there yesterday. Otherwise an empty string",',
    '"reply":"your conversational reply"}',
  ].join('\n');
}

async function handleTalk(text) {
  const log = $('log'); clearEmpty(log);
  const me = el('div', 'msg me', `<div class="label">I heard</div>${esc(text)}`);
  log.appendChild(me); scrollDown(log);

  history.push({ role: 'user', content: text });
  history = history.slice(-16);
  const out = await chatJSON([{ role: 'system', content: talkSystemPrompt() }, ...history]);
  const reply = String(out.reply || '').trim() || 'Sorry, could you say that again?';
  history.push({ role: 'assistant', content: reply });

  const mistakes = Array.isArray(out.mistakes) ? out.mistakes.filter((m) => m && (m.wrong || m.right)) : [];
  if (S.strict !== 'off') {
    const fix = el('div', 'fix' + (mistakes.length ? '' : ' ok'));
    if (mistakes.length) {
      fix.innerHTML = `<div class="title">${mistakes.length === 1 ? '1 correction' : mistakes.length + ' corrections'}</div>` +
        mistakes.map((m) => `<div class="item"><span class="wrong">${esc(m.wrong)}</span> &rarr; <span class="right">${esc(m.right)}</span>` +
          (m.why ? `<div class="why" dir="auto">${esc(m.why)}</div>` : '') + '</div>').join('') +
        (out.corrected ? `<div class="full"><span class="why">Better:</span> ${esc(out.corrected)}</div>` : '');
    } else {
      fix.innerHTML = '<div class="title">No mistakes found</div>';
    }
    log.appendChild(fix);
  }
  const ai = el('div', 'msg ai', `<div class="label">Partner</div><div>${esc(reply)}</div>`);
  const sayBtn = el('button', 'say', 'Play'); sayBtn.type = 'button';
  sayBtn.onclick = () => { unlockAudio(); stopSpeaking(); speak(reply); };
  ai.appendChild(sayBtn);
  log.appendChild(ai); scrollDown(log);

  const fixSpoken = S.sayCorrections && mistakes.length && out.spoken_fix ? String(out.spoken_fix).trim() + ' ' : '';
  await speak(fixSpoken + reply);
  continueHandsFree();
}

/* ---------- repeat-after-me mode ---------- */
const CONTRACTIONS = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are', "he's": 'he is', "she's": 'she is',
  "it's": 'it is', "that's": 'that is', "there's": 'there is', "what's": 'what is', "where's": 'where is',
  "i've": 'i have', "you've": 'you have', "we've": 'we have', "they've": 'they have',
  "i'll": 'i will', "you'll": 'you will', "we'll": 'we will', "they'll": 'they will', "he'll": 'he will', "she'll": 'she will', "it'll": 'it will',
  "i'd": 'i would', "you'd": 'you would', "we'd": 'we would', "they'd": 'they would', "he'd": 'he would', "she'd": 'she would',
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not', "can't": 'can not', "cannot": 'can not', "won't": 'will not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not', "haven't": 'have not', "hasn't": 'has not',
  "hadn't": 'had not', "wouldn't": 'would not', "shouldn't": 'should not', "couldn't": 'could not', "let's": 'let us',
};
function words(s) {
  const raw = String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  raw.forEach((w) => { (CONTRACTIONS[w] || w.replace(/^'+|'+$/g, '')).split(' ').forEach((x) => x && out.push(x)); });
  return out;
}
// Word-level alignment by longest common subsequence.
function align(targetWords, saidWords) {
  const n = targetWords.length, m = saidWords.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = targetWords[i] === saidWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const tHit = new Array(n).fill(false), sHit = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (targetWords[i] === saidWords[j]) { tHit[i] = sHit[j] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { tHit, sHit, score: n ? dp[0][0] / n : 0 };
}

async function nextSentence() {
  if (!apiKey) { setStatus('Add your OpenAI key first.', true); openSettings(); return; }
  unlockAudio(); stopSpeaking();
  setPhase('think'); setStatus('Choosing a sentence...');
  const lenRule = { A2: '5 to 9 words', B1: '7 to 12 words', B2: '9 to 15 words', C1: '12 to 20 words' }[S.level];
  const topic = $('topic').value.trim();
  try {
    const out = await chatJSON([
      { role: 'system', content: [
        `You write sentences for spoken repeat-after-me practice for an adult English learner at CEFR ${S.level}.`,
        `Write one natural, everyday spoken English sentence of ${lenRule}. Vary grammar and situations.`,
        topic ? `Topic: ${topic}.` : '',
        'Return only JSON: {"sentence":"...","focus":"2 to 5 words naming the grammar or sound it practices"}',
      ].join('\n') },
      { role: 'user', content: 'Do not reuse any of these: ' + JSON.stringify(usedSentences.slice(-25)) },
    ], 120);
    const s = String(out.sentence || '').trim();
    if (!s) throw new Error('No sentence came back. Try again.');
    target = { sentence: s, focus: String(out.focus || '').trim() };
    usedSentences.push(s); usedSentences = usedSentences.slice(-60); store.set('ens.used', usedSentences);
    attempts = 0;
    $('target').textContent = s;
    $('focus').textContent = target.focus ? '· ' + target.focus : '';
    $('hearAgain').disabled = false; $('hearSlow').disabled = false;
    await speak(s);
    setStatus('Now tap the mic and repeat it.');
    continueHandsFree();
  } catch (e) {
    setPhase('idle'); setStatus(e.message, true);
  }
}

async function handleRepeat(text) {
  if (!target) { setPhase('idle'); setStatus('Tap Next sentence first.'); return; }
  attempts++;
  const tw = words(target.sentence);
  const display = target.sentence.split(/\s+/);
  const { tHit, sHit, score } = align(tw, words(text));
  // Map normalized hits back onto the displayed words (a contraction may cover two normalized words).
  let k = 0;
  const targetHtml = display.map((tok) => {
    const n = words(tok).length || 1;
    const ok = tHit.slice(k, k + n).every(Boolean); k += n;
    return `<span class="${ok ? 'hit' : 'miss'}">${esc(tok)}</span>`;
  }).join(' ');
  const sw = words(text);
  const saidHtml = sw.map((w, idx) => sHit[idx] ? esc(w) : `<span class="extra">${esc(w)}</span>`).join(' ');
  const pct = Math.round(score * 100);

  const log = $('repeatLog'); clearEmpty(log);
  const card = el('div', 'fix' + (pct === 100 ? ' ok' : ''));
  card.innerHTML = `<div class="title">Try ${attempts} · <span class="score">${pct}%</span></div>` +
    `<div class="diff">${targetHtml}</div>` +
    `<div class="why" style="margin-top:6px">I heard: <span class="diff">${saidHtml || '(nothing)'}</span></div>`;
  log.appendChild(card); scrollDown(log);

  if (pct === 100) {
    await speak('Perfect.');
    setStatus('Perfect. Tap Next sentence.');
    if (S.handsFree && !handsFreeCancelled) { await nextSentence(); }
  } else {
    setStatus('Red words were missed. Listen again or tap the mic to retry.');
    if (S.handsFree && !handsFreeCancelled) {
      if (attempts >= 3) { await speak("Let's try a new one."); await nextSentence(); }
      else { await speak('Listen again. ' + target.sentence, Number(S.rate) * 0.9); continueHandsFree(); }
    } else {
      setPhase('idle');
    }
  }
}

/* ---------- hands-free loop ---------- */
function continueHandsFree() {
  if (!S.handsFree || handsFreeCancelled) return;
  if (mode === 'repeat' && !target) return;
  setTimeout(() => { if (phase === 'idle' && S.handsFree && !handsFreeCancelled) startRec(); }, 250);
}

/* ---------- settings ---------- */
function saveSettings() { store.set('ens.settings', S); }
function openSettings() { renderTotals(); try { $('settings').showModal(); } catch { $('settings').setAttribute('open', ''); } }

function bindSettings() {
  $('apiKey').value = apiKey;
  $('apiKey').addEventListener('change', () => { apiKey = $('apiKey').value.trim(); store.set('ens.key', apiKey); setStatus(apiKey ? 'Key saved on this device.' : 'No key.'); });
  ['level', 'strict', 'explainLang', 'replyLen', 'voiceEngine', 'openaiVoice', ...ADV_KEYS].forEach((id) => {
    const n = $(id); n.value = S[id];
    n.addEventListener('change', () => {
      S[id] = n.type === 'number' ? Number(n.value) : n.value.trim();
      saveSettings(); syncVoiceUI();
    });
  });
  ['sayCorrections', 'autoStop', 'handsFree'].forEach((id) => {
    const n = $(id); n.checked = !!S[id];
    n.addEventListener('change', () => { S[id] = n.checked; saveSettings(); syncHandsFree(); });
  });
  $('deviceVoice').addEventListener('change', () => { S.deviceVoice = $('deviceVoice').value; saveSettings(); });
  $('rate').value = S.rate; $('rateVal').textContent = Number(S.rate).toFixed(2);
  $('rate').addEventListener('input', () => { S.rate = Number($('rate').value); $('rateVal').textContent = S.rate.toFixed(2); saveSettings(); });
  $('testVoice').addEventListener('click', () => { unlockAudio(); stopSpeaking(); speak('Hi! This is how I sound. Shall we practice some English?'); });
  $('resetAdv').addEventListener('click', () => { ADV_KEYS.forEach((k) => { S[k] = DEFAULTS[k]; $(k).value = S[k]; }); saveSettings(); });
  $('forgetKey').addEventListener('click', () => { apiKey = ''; store.del('ens.key'); $('apiKey').value = ''; setStatus('Key removed from this device.'); });
  $('ver').textContent = VERSION;
  syncVoiceUI(); syncHandsFree();
}
function syncVoiceUI() {
  const oa = S.voiceEngine === 'openai';
  $('openaiVoiceWrap').hidden = !oa;
  $('deviceVoiceWrap').hidden = oa;
}
function syncHandsFree() {
  $('handsFreeBtn').setAttribute('aria-pressed', S.handsFree ? 'true' : 'false');
  $('handsFree').checked = !!S.handsFree;
}

/* ---------- wiring ---------- */
function onMic() {
  unlockAudio();
  handsFreeCancelled = false;
  if (phase === 'rec') { stopRec(); return; }
  if (phase === 'think') return;
  if (phase === 'speak') { stopSpeaking(); setPhase('idle'); }
  startRec();
}

function switchMode(m) {
  if (m === mode) return;
  if (phase === 'rec' && rec) { rec.heard = false; stopRec(); }
  stopSpeaking(); setPhase('idle');
  mode = m;
  document.querySelectorAll('.mode').forEach((b) => {
    const on = b.dataset.mode === m; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('talkView').hidden = m !== 'talk';
  $('repeatView').hidden = m !== 'repeat';
  setStatus(m === 'talk' ? 'Tap the mic and speak.' : (target ? 'Tap the mic and repeat the sentence.' : 'Tap Next sentence to start.'));
}

function init() {
  bindSettings();
  emptyState();
  if ('speechSynthesis' in window) { fillVoices(); speechSynthesis.onvoiceschanged = fillVoices; }
  $('mic').addEventListener('click', onMic);
  $('openSettings').addEventListener('click', openSettings);
  $('replay').addEventListener('click', () => { if (lastSpoken) { unlockAudio(); stopSpeaking(); speak(lastSpoken); } });
  $('handsFreeBtn').addEventListener('click', () => {
    S.handsFree = !S.handsFree; saveSettings(); syncHandsFree();
    handsFreeCancelled = !S.handsFree;
    setStatus(S.handsFree ? 'Hands-free on: I listen again after each answer.' : 'Hands-free off.');
  });
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  $('newChat').addEventListener('click', () => {
    history = []; $('log').innerHTML = ''; emptyState(); stopSpeaking(); setPhase('idle'); setStatus('New conversation. Tap the mic and speak.');
  });
  $('nextSentence').addEventListener('click', () => { handsFreeCancelled = false; nextSentence(); });
  $('hearAgain').addEventListener('click', () => { if (target) { unlockAudio(); stopSpeaking(); speak(target.sentence); } });
  $('hearSlow').addEventListener('click', () => { if (target) { unlockAudio(); stopSpeaking(); speak(target.sentence, Math.max(0.5, Number(S.rate) * 0.7)); } });
  $('toggleText').addEventListener('click', () => {
    hideText = !hideText; $('target').classList.toggle('blur', hideText); $('toggleText').textContent = hideText ? 'Show text' : 'Hide text';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { handsFreeCancelled = true; if (phase === 'rec') stopRec(); stopSpeaking(); }
  });
  if (!apiKey) { setStatus('Start by adding your OpenAI key in Settings.'); }
}

init();
