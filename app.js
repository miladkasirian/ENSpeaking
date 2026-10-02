/* EN Speaking: spoken English practice with OpenAI.
   Engines:
     turn     - record -> speech-to-text -> chat model (JSON with corrections) -> voice
     realtime - WebRTC voice call with an OpenAI realtime model
   The API key lives only in this browser's localStorage. */
'use strict';

const VERSION = '2.11.1 (2026-10-02)';
const API = 'https://api.openai.com/v1';

/* ---------- models and published prices (USD) ----------
   chat: per 1M tokens in/out. stt + tts: per minute of audio.
   realtime: per 1M tokens, audio and text, with cached input. */
const CHAT_MODELS = {
  'gpt-4o-mini':  { in: 0.15, out: 0.60, note: 'fast' },
  'gpt-4.1-nano': { in: 0.10, out: 0.40, note: 'fastest' },
  'gpt-4.1-mini': { in: 0.40, out: 1.60, note: 'smarter' },
  'gpt-5.4-nano': { in: 0.20, out: 1.25, note: '' },
  'gpt-5.4-mini': { in: 0.75, out: 4.50, note: 'best corrections' },
};
const STT_MODELS = {
  'gpt-4o-mini-transcribe': { min: 0.003 },
  'gpt-4o-transcribe': { min: 0.006 },
  'whisper-1': { min: 0.006 },
};
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_PRICE_MIN = 0.015;
const RT_MINI = { ain: 10, acached: 0.30, aout: 20, tin: 0.60, tcached: 0.06, tout: 2.40 };
const RT_FULL = { ain: 32, acached: 0.40, aout: 64, tin: 4, tcached: 0.40, tout: 16 };
const RT_MODELS = {
  'gpt-realtime-2.1-mini': RT_MINI,
  'gpt-realtime-mini': RT_MINI,
  'gpt-realtime-2.1': RT_FULL,
  'gpt-realtime': RT_FULL,
};
const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const RT_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];

const DEFAULTS = {
  engine: 'turn',
  level: 'B1', strict: 'all', explainLang: 'English', replyLen: 'short',
  sayCorrections: true, autoStop: true, handsFree: false, speakTyped: true, keepMic: true,
  talkMode: 'practice', // Conversation tab: 'practice' (corrections) or 'open' (free talk, no corrections)
  chatModel: 'gpt-4o-mini', sttModel: 'gpt-4o-mini-transcribe',
  voiceEngine: 'device', deviceVoice: '', openaiVoice: 'coral', rate: 1,
  rtModel: 'gpt-realtime-2.1-mini', rtVoice: 'marin', rtWritten: true,
  gLiveModel: 'gemini-3.8-live', gVoice: 'Kore', gemFree: true,
  // per-provider choices, so switching provider brings back what was picked there last time
  provider: 'gemini',
  oaChat: 'gpt-4o-mini', oaStt: 'gpt-4o-mini-transcribe', oaEngine: 'turn',
  gChat: 'gemini-3.5-flash-lite', gStt: 'gemini-3.5-flash-lite', gEngine: 'glive',
  prices: {},            // user overrides, keyed by model id
};

/* ---------- storage, always guarded ---------- */
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const S = Object.assign({}, DEFAULTS, store.get('ens.settings', {}));
S.prices = Object.assign({}, S.prices);
function applyProvider() {
  const g = S.provider === 'gemini';
  S.chatModel = g ? S.gChat : S.oaChat;
  S.sttModel = g ? S.gStt : S.oaStt;
  S.engine = g ? S.gEngine : S.oaEngine;
  if (g && S.voiceEngine === 'openai') S.voiceEngine = 'device';
}
applyProvider();
let apiKey = store.get('ens.key', '');
let gKey = store.get('ens.gkey', '');
let availableGemini = store.get('ens.gmodels', null);
let availableModels = store.get('ens.models', null); // list of ids from /v1/models, if fetched
const totals = Object.assign({ stt: 0, chat: 0, tts: 0, rt: 0, gem: 0 }, store.get('ens.totals', {}));
const session = { stt: 0, chat: 0, tts: 0, rt: 0, gem: 0, sttSec: 0, chatTok: 0, ttsSec: 0, rtSec: 0, gemSec: 0, gemTok: 0 };
const isCallEngine = () => S.engine === 'realtime' || S.engine === 'glive';
/* With a live engine, both tabs run as a live call. */
const usesCall = () => S.engine === 'glive' || S.engine === 'realtime';
function missingKey(models) {
  for (const m of models) { if (isGem(m) ? !gKey : !apiKey) return isGem(m) ? 'Gemini' : 'OpenAI'; }
  return null;
}
function needKeys(models) {
  const k = missingKey(models); if (!k) return true;
  setStatus(`Add your ${k} key in Settings first.`, true); openSettings(); return false;
}
function endAnyCall(msg, isErr) { if (rt) endCall(msg, isErr); if (gl) endGemini(msg, isErr); }

/* ---------- platform ---------- */
const UA = navigator.userAgent || '';
const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);
const PLATFORM = IS_IOS ? 'ios' : IS_ANDROID ? 'android' : 'desktop';
const DEVICE_VOICE = IS_IOS ? 'iPhone voice' : IS_ANDROID ? 'Android voice' : 'Device voice';
document.documentElement.dataset.platform = PLATFORM;
function micHelp() {
  if (IS_IOS) return 'Microphone access is off. In Safari tap aA, then Website Settings, then Microphone: Allow. Then tap again.';
  if (IS_ANDROID) return 'Microphone access is off. Tap the icon left of the address, then Permissions, then Microphone: Allow. Then tap again.';
  return 'Microphone access is off. Allow it from the icon in the address bar, then tap again.';
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html !== undefined) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(3));

function price(kind, model) {
  const o = S.prices[model] || {};
  if (kind === 'chat') return Object.assign({ in: 0, out: 0 }, CHAT_MODELS[model] || guessChat(model), o);
  if (kind === 'stt') return Object.assign({ min: 0.006 }, STT_MODELS[model], o);
  if (kind === 'tts') return Object.assign({ min: TTS_PRICE_MIN }, o);
  if (kind === 'rt') return Object.assign({}, RT_MODELS[model] || (/mini/.test(model) ? RT_MINI : RT_FULL), o);
  return o;
}
function guessChat(m) {
  // GPT-6 tiers: published per-1M prices (Sep 2026).
  if (/astra/.test(m)) return { in: 10, out: 50 };
  if (/sol/.test(m)) return { in: 2, out: 10 };
  if (/luna/.test(m)) return { in: 0.10, out: 0.50 };
  if (/nano/.test(m)) return { in: 0.20, out: 1.25 };
  if (/mini/.test(m)) return { in: 0.75, out: 4.50 };
  return { in: 0, out: 0, unknown: true };
}

/* ---------- state ---------- */
let mode = 'talk';
let phase = 'idle';   // idle | rec | think | speak | connecting | call
let history = [];
let lastSpoken = '';
let target = null;
let usedSentences = store.get('ens.used', []);
let attempts = 0;
let hideText = false;
let handsFreeCancelled = false;
const levels = { mic: 0, ai: 0 };

/* ---------- small UI helpers ---------- */
function setStatus(text, isErr = false) { const s = $('status'); s.textContent = text; s.classList.toggle('err', isErr); }
function setPhase(p) {
  phase = p;
  const mic = $('mic');
  const glyph = { idle: 'mic', rec: 'stop', think: 'none', speak: 'mic', connecting: 'none', call: 'call' }[p];
  mic.dataset.glyph = (p === 'idle' && usesCall()) ? 'call' : glyph;
  mic.dataset.phase = p;
  mic.setAttribute('aria-label', {
    idle: usesCall() ? 'Start a voice call' : 'Start speaking',
    rec: 'Stop and send', think: 'Working', speak: 'Interrupt and speak', connecting: 'Connecting', call: 'End the call',
  }[p]);
  $('typed').disabled = p === 'connecting';
}
function addCost(kind, usd, extra = {}) {
  if (!isFinite(usd) || usd < 0) return;
  session[kind] += usd;
  totals[kind] += usd;
  for (const [k, v] of Object.entries(extra)) session[k] += v;
  store.set('ens.totals', totals);
  renderSpend(true);
}
function sessionTotal() { return session.stt + session.chat + session.tts + session.rt + session.gem; }
const allTotal = () => totals.stt + totals.chat + totals.tts + totals.rt + totals.gem;
function renderSpend(ticked = false) {
  $('cost').textContent = money(sessionTotal());
  if (ticked) { const b = $('spendBtn'); b.classList.remove('tick'); void b.offsetWidth; b.classList.add('tick'); }
  const rows = [
    ['Speech to text', session.stt, session.sttSec ? `${Math.round(session.sttSec)} s` : ''],
    ['Chat model', session.chat, session.chatTok ? `${session.chatTok.toLocaleString()} tokens` : ''],
    ['OpenAI voice', session.tts, session.ttsSec ? `${Math.round(session.ttsSec)} s` : ''],
    ['OpenAI Realtime', session.rt, session.rtSec ? fmtDur(session.rtSec) : ''],
    ['Gemini' + (S.gemFree ? ', free tier' : ''), session.gem, session.gemSec ? fmtDur(session.gemSec) + ' of calls' : (session.gemTok ? `${session.gemTok.toLocaleString()} tokens` : '')],
  ];
  $('ledgerRows').innerHTML = rows.map(([n, v, d]) => `<div><span>${n}${d ? ` <small>(${d})</small>` : ''}</span><b>${money(v)}</b></div>`).join('') +
    `<div class="sum"><span>This session</span><b>${money(sessionTotal())}</b></div>` +
    `<div><span>All time on this device</span><b>${money(allTotal())}</b></div>`;
}
function fmtDur(s) { const m = Math.floor(s / 60); return m ? `${m} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`; }
function renderTotals() {
  const r = (n, a, b) => `<tr><td>${n}</td><td>${money(a)}</td><td>${money(b)}</td></tr>`;
  $('totals').innerHTML = `<table><tr><td></td><td><small>Session</small></td><td><small>All time</small></td></tr>` +
    r('Speech to text', session.stt, totals.stt) + r('Chat model', session.chat, totals.chat) +
    r('OpenAI voice', session.tts, totals.tts) + r('OpenAI Realtime', session.rt, totals.rt) + r('Gemini', session.gem, totals.gem) +
    `<tr class="sum"><td>Total</td><td>${money(sessionTotal())}</td><td>${money(allTotal())}</td></tr></table>` +
    '<p class="hint">Estimated from the prices below. Exact bills: platform.openai.com (Usage) and aistudio.google.com (Usage).' +
    (S.gemFree ? ' Gemini counts as $0 because you marked your Gemini key as free tier.' : '') + '</p>';
}
function renderEngineChip() {
  const e = S.engine;
  $('engineChip').dataset.engine = e;
  $('engineName').textContent = e === 'realtime' ? 'OpenAI Realtime' : e === 'glive' ? 'Gemini Live' : 'Turn by turn';
  $('engineModel').textContent = e === 'realtime' ? `${S.rtModel}, ${S.rtVoice}` : e === 'glive' ? `${S.gLiveModel}, ${S.gVoice}` :
    `${S.chatModel}, ${S.voiceEngine === 'device' ? DEVICE_VOICE : S.openaiVoice}`;
}
function scrollDown(log) { requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); if (log.id === 'log') persistChat(); }
let persistTimer = null;
function persistChat() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const log = $('log');
    const html = log.querySelector('.empty') ? '' : log.innerHTML;
    store.set('ens.chat', { html, history });
  }, 400);
}
function restoreChat() {
  const c = store.get('ens.chat', null);
  if (!c || !c.html) return;
  $('log').innerHTML = c.html;
  $('log').querySelectorAll('.pending').forEach((n) => n.classList.remove('pending'));
  history = Array.isArray(c.history) ? c.history : [];
  scrollDown($('log'));
}
function emptyState() {
  if (!$('log').children.length) {
    $('log').appendChild(el('div', 'empty',
      '<strong>Say hello to start.</strong>Tap the circle and talk, or type below. You will see exactly what I heard, with corrections under it.'));
  }
  if (!$('repeatLog').children.length) {
    $('repeatLog').appendChild(el('div', 'empty',
      '<strong>Listen, then repeat.</strong>Each try is checked word by word. Words you missed turn red.'));
  }
}
function clearEmpty(log) { log.querySelectorAll('.empty').forEach((n) => n.remove()); }

/* ---------- OpenAI helpers ---------- */
async function apiError(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch { /* ignore */ }
  if (res.status === 401) return new Error('OpenAI rejected the key. Check it in Settings.');
  if (res.status === 429) return new Error('OpenAI says the limit is reached or there is no credit: ' + msg);
  if (res.status === 404 || /model/i.test(msg)) return new Error(msg + ' Pick another model in Settings.');
  return new Error(msg);
}
const authJSON = () => ({ Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' });

async function fetchModels() {
  const res = await fetch(API + '/models', { headers: { Authorization: 'Bearer ' + apiKey } });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  availableModels = (j.data || []).map((m) => m.id).sort();
  store.set('ens.models', availableModels);
  return availableModels;
}

async function transcribe(blob, ext, seconds) {
  if (isGem(S.sttModel)) { session.sttSec += seconds; return geminiTranscribe(blob); }
  const fd = new FormData();
  fd.append('file', blob, 'speech.' + ext);
  fd.append('model', S.sttModel);
  fd.append('language', 'en');
  fd.append('response_format', 'json');
  fd.append('prompt', prompt('transcription'));
  const res = await fetch(API + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: fd });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  addCost('stt', (seconds / 60) * price('stt', S.sttModel).min, { sttSec: seconds });
  return (j.text || '').trim();
}

const reasoningParam = {}; // per model: which reasoning setting the API accepted
async function chatJSON(messages, maxTokens = 600) {
  const m = S.chatModel;
  if (isGem(m)) return geminiJSON(messages, maxTokens);
  const isReasoning = /^(gpt-5|gpt-6|o\d)/.test(m);
  const tries = isReasoning ? (reasoningParam[m] !== undefined ? [reasoningParam[m]] : ['minimal', 'none', 'low', null]) : [null];
  let lastErr;
  for (const effort of tries) {
    const body = { model: m, messages, response_format: { type: 'json_object' }, max_completion_tokens: isReasoning ? maxTokens + 1500 : maxTokens };
    if (effort) body.reasoning_effort = effort;
    const res = await fetch(API + '/chat/completions', { method: 'POST', headers: authJSON(), body: JSON.stringify(body) });
    if (!res.ok) {
      lastErr = await apiError(res);
      if (res.status === 400 && /reasoning/i.test(lastErr.message)) continue;
      throw lastErr;
    }
    if (isReasoning) reasoningParam[m] = effort;
    const j = await res.json();
    const u = j.usage || {};
    const p = price('chat', m);
    addCost('chat', ((u.prompt_tokens || 0) * p.in + (u.completion_tokens || 0) * p.out) / 1e6, { chatTok: (u.total_tokens || 0) });
    const txt = j.choices?.[0]?.message?.content || '{}';
    try { return JSON.parse(txt); } catch { throw new Error('The model sent an answer I could not read. Try again.'); }
  }
  throw lastErr;
}

/* ---------- voice output (turn-by-turn) ---------- */
const audioEl = new Audio();
audioEl.preload = 'auto';
audioEl.setAttribute('playsinline', '');
let audioUnlocked = false;
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
/* iPhone: without this, page audio is "ambient": the volume buttons change the ringer
   instead, and the silent switch mutes it. 'playback' makes it media audio (iOS 17+). */
function setAudioSession(type) {
  try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { /* older browsers */ }
}
/* iPhone sends page audio (Web Audio) to the ringer channel, so the volume buttons ignore it.
   A silent clip looping in an <audio> element opens the media channel; the page's other audio then
   follows the media volume and the volume buttons work. Started from a tap, paused in the background. */
let mediaKeeper = null;
function silentLoopUrl() {
  const n = 8000; const b = new DataView(new ArrayBuffer(44 + n));
  const w = (o, t) => { for (let i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); b.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, 8000, true); b.setUint32(28, 8000, true);
  b.setUint16(32, 1, true); b.setUint16(34, 8, true); w(36, 'data'); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128); // 8-bit silence
  return URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }));
}
function keepMediaChannel() {
  if (!IS_IOS) return; // only iPhone needs it; on Android it would add a media notification
  try {
    if (!mediaKeeper) {
      mediaKeeper = new Audio(silentLoopUrl());
      mediaKeeper.loop = true; mediaKeeper.setAttribute('playsinline', ''); mediaKeeper.volume = 1;
      if ('mediaSession' in navigator && window.MediaMetadata) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'EN Speaking', artist: 'English practice' });
      }
    }
    if (mediaKeeper.paused) mediaKeeper.play().catch(() => {});
  } catch { /* not supported */ }
}
function unlockAudio() {
  keepMediaChannel();
  if (!rec && !rt && !gl) setAudioSession('playback');
  if (audioUnlocked) return;
  audioUnlocked = true;
  try { audioEl.src = SILENT_WAV; audioEl.play().catch(() => {}); } catch { /* ignore */ }
  try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch { /* ignore */ }
}
function englishVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
}
function pickVoice() {
  const vs = englishVoices();
  return vs.find((v) => v.voiceURI === S.deviceVoice) ||
    vs.find((v) => /premium|enhanced/i.test(v.name) && /en-US/i.test(v.lang)) ||
    vs.find((v) => /samantha|ava|allison|evan|daniel/i.test(v.name)) ||
    vs.find((v) => /en-US/i.test(v.lang)) || vs[0] || null;
}
function fillDeviceVoices() {
  const sel = $('deviceVoice'); const vs = englishVoices(); const chosen = pickVoice();
  sel.innerHTML = '';
  if (!vs.length) { sel.appendChild(el('option', '', 'Default English voice')); return; }
  vs.forEach((v) => { const o = el('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`; if (chosen && chosen.voiceURI === v.voiceURI) o.selected = true; sel.appendChild(o); });
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
    const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = rate;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(finish, 2500 + (text.length * 85) / rate); // Safari sometimes skips onend
    u.onend = finish; u.onerror = finish;
    speechSynthesis.speak(u);
  });
}
async function speakOpenAI(text, rate) {
  const res = await fetch(API + '/audio/speech', {
    method: 'POST', headers: authJSON(),
    body: JSON.stringify({ model: TTS_MODEL, voice: S.openaiVoice, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) throw await apiError(res);
  const url = URL.createObjectURL(await res.blob());
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(); } };
    audioEl.onended = finish; audioEl.onerror = finish;
    audioEl.onpause = () => { if (audioEl.src === url) finish(); };
    audioEl.onloadedmetadata = () => {
      if (isFinite(audioEl.duration)) addCost('tts', (audioEl.duration / 60) * price('tts', TTS_MODEL).min, { ttsSec: audioEl.duration });
    };
    audioEl.src = url; audioEl.playbackRate = rate;
    audioEl.play().catch(() => { setStatus('Tap the replay button to hear the answer.'); finish(); });
  });
}
async function speak(text, rate = Number(S.rate)) {
  if (!text) return;
  lastSpoken = text; $('replay').disabled = false;
  setPhase('speak'); setStatus('Speaking. Tap the circle to answer straight away.');
  try {
    if (S.voiceEngine === 'openai') await speakOpenAI(text, rate); else await speakDevice(text, rate);
  } catch (e) {
    setStatus(e.message + ` Using the ${DEVICE_VOICE} instead.`, true);
    await speakDevice(text, rate);
  }
  if (phase === 'speak') { setPhase('idle'); setStatus(mode === 'talk' ? 'Your turn. Tap the circle or type.' : 'Tap the circle and repeat.'); }
}

/* ---------- recording (turn-by-turn) ---------- */
let audioCtx = null;
let rec = null;
function getCtx() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
  return audioCtx;
}
/* One microphone stream for the whole visit. Safari asks for permission again when the mic has been
   off for about a minute, so between turns the mic is muted instead of closed (setting "keepMic").
   It is fully released when the app goes to the background. */
let micStream = null;
async function getMic() {
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live')) {
    micStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    return micStream;
  }
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  return micStream;
}
function releaseMic(force = false) {
  if (!micStream) return;
  if (S.keepMic && !force && !document.hidden) { micStream.getAudioTracks().forEach((t) => { t.enabled = false; }); return; }
  micStream.getTracks().forEach((t) => t.stop()); micStream = null;
}
function buzz(ms) { try { if (IS_ANDROID && navigator.vibrate) navigator.vibrate(ms); } catch { /* ignore */ } }

function pickMime() {
  if (!window.MediaRecorder) return null;
  const order = IS_IOS
    ? [['audio/mp4', 'mp4'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']]
    : [['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/mp4', 'mp4']];
  for (const [m, ext] of order) {
    if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext };
  }
  return { mime: '', ext: 'webm' };
}
function meter(stream, onLevel) {
  const ctx = getCtx(); if (!ctx) return null;
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let alive = true;
  const tick = () => {
    if (!alive) return;
    an.getFloatTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    onLevel(Math.sqrt(s / buf.length));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { alive = false; try { src.disconnect(); } catch { /* ignore */ } };
}

async function startRec() {
  if (!needKeys([S.sttModel, S.chatModel])) return;
  setAudioSession('play-and-record');
  const fmt = pickMime();
  if (!fmt || !navigator.mediaDevices?.getUserMedia) { setStatus('This browser cannot record audio.', true); return; }
  let stream;
  try {
    stream = await getMic();
  } catch (e) {
    setAudioSession('playback');
    setPhase('idle');
    setStatus(e.name === 'NotAllowedError' ? micHelp() : 'Microphone error: ' + e.message, true);
    return;
  }
  const chunks = [];
  const mr = new MediaRecorder(stream, fmt.mime ? { mimeType: fmt.mime } : undefined);
  const r = { mr, stream, chunks, ext: fmt.ext, mime: mr.mimeType || fmt.mime, t0: performance.now(), heard: false, stopped: false };
  rec = r;
  mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  mr.onstop = () => onRecorded(r);
  mr.start(); buzz(15);
  setPhase('rec');
  setStatus(S.autoStop ? 'Listening. I send it when you pause.' : 'Listening. Tap again when you finish.');

  let floor = 0, nFloor = 0, lastLoud = performance.now();
  r.stopMeter = meter(stream, (rms) => {
    if (r.stopped) return;
    const now = performance.now(), dt = now - r.t0;
    if (dt < 300) { floor += rms; nFloor++; }
    const thr = Math.max(0.012, (nFloor ? floor / nFloor : 0) * 2.5);
    if (rms > thr) { r.heard = true; lastLoud = now; }
    levels.mic = Math.min(1, rms * 10);
    if (S.autoStop && r.heard && now - lastLoud > 1400) stopRec();
    else if (S.autoStop && !r.heard && dt > 9000) stopRec();
    else if (dt > 90000) stopRec();
  });
  if (!r.stopMeter) r.heard = true;
}
function stopRec() {
  const r = rec; if (!r || r.stopped) return;
  r.stopped = true; r.t1 = performance.now();
  try { r.mr.stop(); } catch { /* ignore */ }
  releaseMic();
  setAudioSession('playback');
  buzz(10);
  if (r.stopMeter) r.stopMeter();
  levels.mic = 0;
  setPhase('think'); setStatus('Thinking...');
}
async function onRecorded(r) {
  rec = null;
  const seconds = Math.max(0.1, ((r.t1 || performance.now()) - r.t0) / 1000);
  const blob = new Blob(r.chunks, { type: r.mime || 'audio/mp4' });
  if (!r.heard || blob.size < 1000) { setPhase('idle'); setStatus("I didn't hear anything. Tap the circle to try again."); return; }
  try {
    const text = await transcribe(blob, r.ext, seconds);
    if (!text) { setPhase('idle'); setStatus("I couldn't make out any words. Try again."); return; }
    if (mode === 'talk') await handleTalk(text, false); else await handleRepeat(text);
  } catch (e) { setPhase('idle'); setStatus(e.message, true); }
}

/* ---------- conversation ---------- */
function tutorRules() {
  return {
    all: 'Report every grammar, word-choice and unnatural-phrasing mistake.',
    major: 'Report only clear grammar mistakes and wrong words that change or blur the meaning.',
    off: 'Do not report mistakes: always return an empty "mistakes" list, an empty "corrected" and an empty "spoken_fix".',
  }[S.strict];
}
const REPLY_LEN = {
  short: 'SHORT: one or two short sentences, at most 25 words in total',
  medium: 'MEDIUM: three to five sentences, about 40 to 70 words in total',
};
/* ---------- editable instructions ----------
   Defaults live in prompts.json on GitHub. Your saved edits (localStorage) win until you reset them.
   The output formats the app depends on are added by the code, so an edit cannot break the app. */
const PROMPTS = [
  ['liveConversation', 'Live call: conversation'],
  ['liveCorrections', 'Live call: how to correct you out loud'],
  ['liveRepeat', 'Live call: Repeat after me drill'],
  ['conversation', 'Turn by turn: conversation'],
  ['openTalk', 'Open talk: free conversation, no corrections'],
  ['repeatSentence', 'Turn by turn: choosing a sentence to repeat'],
  ['checker', 'Written corrections (checker)'],
  ['transcription', 'Speech to text'],
];
let promptDefaults = store.get('ens.promptDefaults', null);
let promptEdits = store.get('ens.prompts', {});
async function loadPromptDefaults(fresh = false) {
  const res = await fetch('prompts.json', { cache: fresh ? 'reload' : 'no-cache' });
  if (!res.ok) throw new Error('Could not load the default instructions from GitHub (HTTP ' + res.status + ').');
  promptDefaults = await res.json();
  store.set('ens.promptDefaults', promptDefaults);
  return promptDefaults;
}
function rawPrompt(key) {
  if (typeof promptEdits[key] === 'string') return promptEdits[key];
  if (promptDefaults && typeof promptDefaults[key] === 'string') return promptDefaults[key];
  throw new Error('The instructions have not loaded yet. Check the internet connection and try again.');
}
function topicLine(kind) {
  const t = $('topic').value.trim();
  if (kind === 'drill') return t ? `Use sentences about this topic: ${t}.` : '';
  return t ? `Conversation topic: ${t}.` : 'Let the learner choose the topic. If they have nothing to say, suggest an everyday topic.';
}
function openingLine(kind) {
  const t = $('topic').value.trim();
  if (kind === 'drill') {
    return t ? `The learner wants to practice this situation: ${t}. Make every sentence fit it. Start right away with the first sentence.`
      : 'At the very start, greet the learner briefly and ask in one short sentence which real-life situation they want to practice, for example ordering at a cafe, a job interview, or a doctor visit. Wait for the answer, then make every sentence fit the situation they describe. If they describe their own situation in detail, use their details.';
  }
  return t ? `The learner chose this topic or situation: ${t}. Start the conversation about it right away with a friendly question.`
    : 'At the very start, greet the learner briefly and ask in one short sentence what they want to talk about or which real-life situation they want to practice, for example a job interview, ordering food, or small talk with a neighbor. Then build the whole conversation around what they describe, using their own details.';
}
function promptVars(extra = {}) {
  const speakFix = S.strict !== 'off' && S.sayCorrections;
  const scope = S.strict === 'major'
    ? 'clear grammar mistakes and wrong words that change or blur the meaning (ignore small style issues)'
    : 'every grammar mistake, wrong word, wrong verb form, missing or wrong article, and unnatural phrasing';
  const v = {
    level: S.level, explainLang: S.explainLang,
    replyLength: REPLY_LEN[S.replyLen] || REPLY_LEN.short,
    drillLength: drillLength(),
    speakingPace: speakingPace(),
    feedbackLength: S.replyLen === 'short' ? 'one short sentence, at most 15 words' : 'two or three sentences',
    corrections: tutorRules(), correctionScope: scope,
    topic: topicLine('talk'), inputNote: '', opening: openingLine('talk'),
  };
  Object.assign(v, extra);
  if (v.spokenCorrections === undefined) {
    v.spokenCorrections = speakFix ? fillPrompt(rawPrompt('liveCorrections'), v) : 'Do not correct the learner out loud; just keep the conversation going.';
  }
  return v;
}
/* Open talk: the Conversation tab without corrections. */
const isOpenTalk = () => S.talkMode === 'open';
function openTalkVars() {
  if (!isOpenTalk()) return {};
  const note = fillPrompt(rawPrompt('openTalk'), {});
  return {
    corrections: note + ' Always return an empty "mistakes" list, an empty "corrected" and an empty "spoken_fix".',
    spokenCorrections: note,
  };
}
function fillPrompt(text, vars) { return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)).replace(/\n{3,}/g, '\n\n').trim(); }
function prompt(key, extra) { return fillPrompt(rawPrompt(key), promptVars(extra)); }

/* Live voices cannot be sped up without changing pitch, so the speed setting is passed as an instruction. */
function speakingPace() {
  const r = Number(S.rate) || 1;
  if (r <= 0.75) return 'Speak slowly and clearly, with short pauses between phrases.';
  if (r < 0.95) return 'Speak a little slower than normal, clearly.';
  if (r <= 1.1) return 'Speak clearly, at a natural pace.';
  return 'Speak a little faster than normal, like a fluent native speaker.';
}
/* Drill sentence length follows both the level and the Short/Medium setting. */
function drillLength() {
  const t = S.replyLen === 'short'
    ? { A2: '4 to 7 words', B1: '5 to 9 words', B2: '6 to 10 words', C1: '7 to 12 words' }
    : { A2: '6 to 10 words', B1: '8 to 13 words', B2: '10 to 16 words', C1: '12 to 20 words' };
  return t[S.level] || t.B1;
}
function talkSystemPrompt(typed) {
  return [
    prompt('conversation', { ...openTalkVars(),
      inputNote: typed ? 'The learner typed this message. Treat it as conversation practice; ignore capitalization and small typos.'
        : "This is spoken practice. The message is a speech-to-text transcript, so ignore punctuation, capitalization and spelling. If a word looks like a speech-recognition slip rather than the learner's own mistake, ignore it.",
    }),
    'Return only a JSON object with these keys:',
    '{"mistakes":[{"wrong":"their exact words","right":"corrected words","why":"short explanation"}],',
    '"corrected":"their whole message corrected and natural, or empty if no mistakes",',
    '"spoken_fix":"if there were mistakes, a very short recast to say aloud, like: You could say, I went there yesterday. Otherwise empty",',
    '"reply":"your reply"}',
  ].join('\n');
}
function renderFix(log, out) {
  if (S.strict === 'off') return [];
  const mistakes = Array.isArray(out.mistakes) ? out.mistakes.filter((m) => m && (m.wrong || m.right)) : [];
  const fix = el('div', 'fix' + (mistakes.length ? '' : ' ok'));
  if (mistakes.length) {
    fix.innerHTML = `<div class="title">${mistakes.length === 1 ? 'One thing to fix' : mistakes.length + ' things to fix'}</div>` +
      mistakes.map((m) => `<div class="item"><span class="wrong">${esc(m.wrong)}</span> <span aria-hidden="true">&rarr;</span> <span class="right">${esc(m.right)}</span>` +
        (m.why ? `<div class="why" dir="auto">${esc(m.why)}</div>` : '') + '</div>').join('') +
      (out.corrected ? `<div class="full"><span class="why">More natural:</span> ${esc(out.corrected)}</div>` : '');
  } else {
    fix.innerHTML = '<div class="title">Correct English. Nice.</div>';
  }
  log.appendChild(fix);
  return mistakes;
}
function bubble(log, who, text, opts = {}) {
  const b = el('div', 'msg ' + (who === 'me' ? 'me' : 'ai') + (opts.pending ? ' pending' : ''));
  b.innerHTML = `<div class="who">${who === 'me' ? (opts.typed ? 'You wrote' : 'I heard') : 'Partner'}</div><div class="txt">${esc(text)}</div>`;
  if (opts.play) {
    const p = el('button', 'play', 'Play again'); p.type = 'button'; p.dataset.say = text;
    b.appendChild(p);
  }
  log.appendChild(b); scrollDown(log);
  return b;
}
async function handleTalk(text, typed) {
  const log = $('log'); clearEmpty(log);
  bubble(log, 'me', text, { typed });
  if (talkDrill && practiceLoop()) {
    const pct = attemptCard(log, talkDrill.sentence, text, ++talkDrill.tries);
    if (pct === 100) { await speak('Good. Say it once more, or tap OK, continue.'); setStatus('Good. Say it again, or tap OK, continue.'); }
    else { await speak('Try again. ' + talkDrill.sentence, Number(S.rate) * 0.9); setStatus('Try again, or tap OK, continue.'); }
    if (!typed) continueHandsFree();
    return;
  }
  setPhase('think'); setStatus('Thinking...');
  history.push({ role: 'user', content: text }); history = history.slice(-16);
  const out = await chatJSON([{ role: 'system', content: talkSystemPrompt(typed) }, ...history]);
  const reply = String(out.reply || '').trim() || 'Sorry, could you say that again?';
  history.push({ role: 'assistant', content: reply });
  const mistakes = isOpenTalk() ? [] : renderFix(log, out);
  if (mistakes.length && out.corrected && practiceLoop()) {
    // hold the reply; first practice the corrected sentence until you tap OK, continue
    setTalkDrill(String(out.corrected).trim(), reply);
    const fix = out.spoken_fix ? String(out.spoken_fix).trim() + ' ' : '';
    if (typed && !S.speakTyped) { setPhase('idle'); setStatus('Say or type the corrected sentence, or tap OK, continue.'); return; }
    await speak(fix + 'Now you say it: ' + talkDrill.sentence);
    setStatus('Say the corrected sentence. Tap OK, continue when you are ready.');
    if (!typed) continueHandsFree();
    return;
  }
  bubble(log, 'ai', reply, { play: true });
  if (typed && !S.speakTyped) { setPhase('idle'); setStatus('Your turn. Tap the circle or type.'); return; }
  const fixSpoken = S.sayCorrections && mistakes.length && out.spoken_fix ? String(out.spoken_fix).trim() + ' ' : '';
  await speak(fixSpoken + reply);
  if (!typed) continueHandsFree();
}

/* ---------- practice loop in the Conversation tab ----------
   In Practice mode a correction becomes a sentence to say again. The app stays on it,
   checking each try, until you tap "OK, continue". Open talk skips all of this. */
let talkDrill = null; // { sentence, tries, reply? (turn by turn: the reply held back until you continue) }
const practiceLoop = () => !isOpenTalk() && S.strict !== 'off' && S.sayCorrections;
function setTalkDrill(sentence, reply) {
  talkDrill = { sentence, tries: 0, reply: reply || (talkDrill && talkDrill.sentence === sentence ? talkDrill.reply : null) };
  $('drillText').textContent = sentence; $('drillBar').hidden = false;
}
function clearTalkDrill() { talkDrill = null; $('drillBar').hidden = true; }
/* A live coach turn finished: if it asked for a sentence again, pin it. */
function liveTalkTurnDone(text) {
  if (!practiceLoop()) return;
  const d = parseDrill(text);
  if (d) setTalkDrill(d.sentence);
}
/* What you said while a sentence is pinned is checked against it instead of being corrected again. */
function liveTalkUserSaid(text) {
  if (!talkDrill || !text) return false;
  talkDrill.tries++;
  attemptCard($('log'), talkDrill.sentence, text, talkDrill.tries);
  return true;
}
async function continueFromDrill() {
  const d = talkDrill; clearTalkDrill();
  const msg = "OK, let's continue the conversation.";
  if (rt) { rtSay(msg); return; }
  if (gl) { geminiSay(msg); return; }
  if (d && d.reply) { bubble($('log'), 'ai', d.reply, { play: true }); await speak(d.reply); continueHandsFree(); }
}

/* ---------- repeat after me ---------- */
const CONTRACTIONS = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are', "he's": 'he is', "she's": 'she is', "it's": 'it is',
  "that's": 'that is', "there's": 'there is', "what's": 'what is', "where's": 'where is', "i've": 'i have', "you've": 'you have',
  "we've": 'we have', "they've": 'they have', "i'll": 'i will', "you'll": 'you will', "we'll": 'we will', "they'll": 'they will',
  "he'll": 'he will', "she'll": 'she will', "it'll": 'it will', "i'd": 'i would', "you'd": 'you would', "we'd": 'we would',
  "they'd": 'they would', "he'd": 'he would', "she'd": 'she would', "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "can't": 'can not', "cannot": 'can not', "won't": 'will not', "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not',
  "weren't": 'were not', "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not', "wouldn't": 'would not',
  "shouldn't": 'should not', "couldn't": 'could not', "let's": 'let us',
};
function words(s) {
  const raw = String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  raw.forEach((w) => (CONTRACTIONS[w] || w.replace(/^'+|'+$/g, '')).split(' ').forEach((x) => x && out.push(x)));
  return out;
}
function align(t, s) {
  const n = t.length, m = s.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = t[i] === s[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const tHit = new Array(n).fill(false), sHit = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (t[i] === s[j]) { tHit[i] = sHit[j] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return { tHit, sHit, score: n ? dp[0][0] / n : 0 };
}
async function nextSentence() {
  if (!needKeys([S.chatModel])) return;
  unlockAudio(); stopSpeaking();
  setPhase('think'); setStatus('Choosing a sentence...');
  try {
    const out = await chatJSON([
      { role: 'system', content: [
        prompt('repeatSentence', { topic: topicLine('drill') }),
        'Return only JSON: {"sentence":"...","focus":"2 to 5 words naming the grammar or sound it practices"}',
      ].join('\n') },
      { role: 'user', content: 'Do not reuse any of these: ' + JSON.stringify(usedSentences.slice(-25)) },
    ], 150);
    const s = String(out.sentence || '').trim();
    if (!s) throw new Error('No sentence came back. Tap Next sentence again.');
    target = { sentence: s, focus: String(out.focus || '').trim() };
    usedSentences.push(s); usedSentences = usedSentences.slice(-60); store.set('ens.used', usedSentences);
    attempts = 0;
    $('target').textContent = s; $('focus').textContent = target.focus;
    $('hearAgain').disabled = false; $('hearSlow').disabled = false;
    await speak(s);
    setStatus('Now tap the circle and repeat it.');
    continueHandsFree();
  } catch (e) { setPhase('idle'); setStatus(e.message, true); }
}
/* Draws one try against the target sentence and returns the share of words hit, in percent. */
function renderAttempt(text) {
  attempts++;
  return attemptCard($('repeatLog'), target.sentence, text, attempts);
}
/* A word-by-word check of one try against a sentence, drawn into the given log. Returns percent. */
function attemptCard(log, sentence, text, n) {
  const { tHit, sHit, score } = align(words(sentence), words(text));
  let k = 0;
  const targetHtml = sentence.split(/\s+/).map((tok) => {
    const n = words(tok).length || 1; const ok = tHit.slice(k, k + n).every(Boolean); k += n;
    return `<span class="${ok ? 'hit' : 'miss'}">${esc(tok)}</span>`;
  }).join(' ');
  const saidHtml = words(text).map((w, i) => sHit[i] ? esc(w) : `<span class="extra">${esc(w)}</span>`).join(' ');
  const pct = Math.round(score * 100);
  clearEmpty(log);
  const card = el('div', 'fix' + (pct === 100 ? ' ok' : ''));
  card.innerHTML = `<div class="title">Try ${n}: <span class="score">${pct}%</span> of the words</div>` +
    `<div class="diff">${targetHtml}</div><div class="why" style="margin-top:6px">I heard: <span class="diff">${saidHtml || '(nothing)'}</span></div>`;
  log.appendChild(card); scrollDown(log);
  return pct;
}
async function handleRepeat(text) {
  if (!target) { setPhase('idle'); setStatus('Tap Next sentence first.'); return; }
  const pct = renderAttempt(text);
  // Stays on this sentence until you tap Next sentence.
  if (pct === 100) {
    await speak('Perfect. Say it again, or tap Next sentence.');
    setStatus('Perfect. Say it again, or tap Next sentence when you are ready.');
  } else {
    await speak('Listen again. ' + target.sentence, Number(S.rate) * 0.9);
    setStatus('Red words were missed. Try again. Tap Next sentence when you are ready to move on.');
  }
  if (S.handsFree && !handsFreeCancelled) continueHandsFree(); else if (phase !== 'rec') setPhase('idle');
}
function continueHandsFree() {
  if (!S.handsFree || handsFreeCancelled) return;
  if (mode === 'repeat' && !target) return;
  setTimeout(() => { if (phase === 'idle' && S.handsFree && !handsFreeCancelled) startRec(); }, 250);
}

/* ---------- realtime call (WebRTC) ---------- */
let rt = null;
function rtInstructions() {
  const base = prompt('liveConversation', openTalkVars());
  if (!practiceLoop()) return base;
  return base + ' When you ask the learner to say a corrected sentence or word again, end that turn with exactly: "Repeat after me: <the corrected sentence or word>". Use this pattern for every new try. Do not continue the conversation until the learner says "OK, let\'s continue".';
}
/* Practice settings changed during a live call: apply them to the call now. */
function liveSettingsChanged() {
  if (rt && rt.dc && rt.dc.readyState === 'open') {
    rt.dc.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: rt.kind === 'repeat' ? repeatInstructions() : rtInstructions(), audio: { output: { speed: Math.max(0.25, Math.min(1.5, Number(S.rate) || 1)) } } } }));
    setStatus('New settings applied to this call.');
  } else if (gl) {
    setStatus(geminiApplySettings() ? 'Applying the new settings to this call...' : 'The new settings start with your next call.');
  }
}
async function startCall(kind = 'talk') {
  if (!apiKey) { setStatus('Add your OpenAI key in Settings first.', true); openSettings(); return; }
  if (!window.RTCPeerConnection) { setStatus('This browser does not support realtime calls.', true); return; }
  setPhase('connecting'); setStatus('Connecting...');
  setAudioSession('play-and-record');
  const state = { kind, pc: null, dc: null, stream: null, audio: null, stopMeters: [], items: {}, t0: 0, timer: null };
  rt = state;
  try {
    state.stream = await getMic();
    const sessionCfg = {
      type: 'realtime', model: S.rtModel, instructions: kind === 'repeat' ? repeatInstructions() : rtInstructions(),
      audio: {
        input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' }, turn_detection: { type: 'semantic_vad' } },
        output: { voice: S.rtVoice, speed: Math.max(0.25, Math.min(1.5, Number(S.rate) || 1)) },
      },
    };
    const sres = await fetch(API + '/realtime/client_secrets', { method: 'POST', headers: authJSON(), body: JSON.stringify({ session: sessionCfg }) });
    if (!sres.ok) throw await apiError(sres);
    const sj = await sres.json();
    const ek = sj.value || sj.client_secret?.value;
    if (!ek) throw new Error('OpenAI did not return a session key.');
    if (rt !== state) return; // ended while connecting

    const pc = new RTCPeerConnection(); state.pc = pc;
    const audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', ''); state.audio = audio;
    document.body.appendChild(audio); audio.style.display = 'none';
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
      const stop = meter(e.streams[0], (rms) => { levels.ai = Math.min(1, rms * 9); });
      if (stop) state.stopMeters.push(stop);
    };
    state.stream.getTracks().forEach((t) => pc.addTrack(t, state.stream));
    const m = meter(state.stream, (rms) => { levels.mic = Math.min(1, rms * 10); });
    if (m) state.stopMeters.push(m);
    const dc = pc.createDataChannel('oai-events'); state.dc = dc;
    dc.onmessage = (e) => { try { onRtEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
    dc.onopen = () => {
      state.t0 = performance.now();
      setPhase('call');
      if (kind === 'repeat') { setStatus('Live drill. Listen, then repeat. Tap the circle to stop.'); rtSay("Hi! Let's start."); }
      else { setStatus('You are live. Just talk. Tap the circle to hang up.'); rtSay('Hi!'); }
      state.timer = setInterval(() => {
        if (rt !== state) return;
        const sec = (performance.now() - state.t0) / 1000;
        if (!/^Hearing/.test($('status').textContent)) $('status').textContent = `Live for ${fmtDur(sec)}. Tap the circle to hang up.`;
      }, 1000);
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && rt === state) endCall('The call dropped.'); };
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    const ares = await fetch(API + '/realtime/calls', { method: 'POST', body: offer.sdp, headers: { Authorization: 'Bearer ' + ek, 'Content-Type': 'application/sdp' } });
    if (!ares.ok) throw await apiError(ares);
    await pc.setRemoteDescription({ type: 'answer', sdp: await ares.text() });
  } catch (e) {
    endCall(e.name === 'NotAllowedError' ? micHelp() : e.message, true);
  }
}
function endCall(msg, isErr = false) {
  const st = rt; if (!st) return;
  rt = null;
  if (st.t0) session.rtSec += (performance.now() - st.t0) / 1000;
  clearInterval(st.timer);
  st.stopMeters.forEach((f) => f());
  try { st.dc && st.dc.close(); } catch { /* ignore */ }
  try { st.pc && st.pc.close(); } catch { /* ignore */ }
  if (st.stream) releaseMic();
  if (st.audio) { st.audio.srcObject = null; st.audio.remove(); }
  setAudioSession('playback');
  levels.mic = levels.ai = 0;
  setPhase('idle'); renderSpend();
  setStatus(msg || `Call ended. This session so far: ${money(sessionTotal())}.`, isErr);
}
function rtLog() { return rt && rt.kind === 'repeat' ? $('repeatLog') : $('log'); }
function rtBubble(id, who) {
  const st = rt; if (!st) return null;
  if (!st.items[id]) { clearEmpty(rtLog()); st.items[id] = bubble(rtLog(), who, '', { pending: who === 'me' }); }
  return st.items[id];
}
/* Send a request to the realtime model as if typed (used by the drill buttons). */
function rtSay(text) {
  const st = rt; if (!st || !st.dc || st.dc.readyState !== 'open') return false;
  st.dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  st.dc.send(JSON.stringify({ type: 'response.create' }));
  return true;
}
function onRtRepeatEvent(ev) {
  const t = ev.type || '';
  if (t === 'input_audio_buffer.speech_started') { setStatus('Hearing you...'); return true; }
  if (t === 'conversation.item.input_audio_transcription.completed') {
    const text = String(ev.transcript || '').trim();
    if (text && target) renderAttempt(text);
    setStatus('Live drill. Listen, then repeat. Tap the circle to stop.');
    return false; // let the cost code below run
  }
  if (t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done') {
    const b = rtBubble(ev.item_id, 'ai'); const d = parseDrill(ev.transcript || '');
    if (d) {
      if (!target || target.sentence !== d.sentence) attempts = 0;
      target = { sentence: d.sentence, focus: '' };
      $('target').textContent = d.sentence; $('focus').textContent = '';
      $('hearAgain').disabled = false; $('hearSlow').disabled = false;
      if (b) { if (d.before) b.querySelector('.txt').textContent = d.before; else b.remove(); }
      setStatus('Now repeat the sentence.');
    }
    return true;
  }
  return false;
}
function onRtEvent(ev) {
  const t = ev.type || '';
  if (rt && rt.kind === 'repeat') {
    if (onRtRepeatEvent(ev)) return;
    if (t === 'input_audio_buffer.committed') return;
  }
  if (t === 'conversation.item.input_audio_transcription.completed' && rt && rt.kind === 'repeat') {
    const u = ev.usage;
    if (u && u.type === 'duration' && u.seconds) addCost('rt', (u.seconds / 60) * 0.003);
    else if (u && u.input_tokens) addCost('rt', ((u.input_tokens || 0) * 1.25 + (u.output_tokens || 0) * 5) / 1e6);
    return;
  }
  if (t === 'input_audio_buffer.committed' || t === 'input_audio_buffer.speech_started') {
    if (ev.item_id) { const b = rtBubble(ev.item_id, 'me'); if (b && !b.querySelector('.txt').textContent) b.querySelector('.txt').textContent = '...'; }
    if (t === 'input_audio_buffer.speech_started') setStatus('Listening...');
  } else if (t === 'conversation.item.input_audio_transcription.completed') {
    const b = rtBubble(ev.item_id, 'me');
    const text = String(ev.transcript || '').trim();
    if (b) { b.classList.remove('pending'); b.querySelector('.txt').textContent = text || '(not clear)'; }
    const u = ev.usage;
    if (u && u.type === 'duration' && u.seconds) addCost('rt', (u.seconds / 60) * 0.003);
    else if (u && u.input_tokens) addCost('rt', ((u.input_tokens || 0) * 1.25 + (u.output_tokens || 0) * 5) / 1e6);
    if (text && !liveTalkUserSaid(text) && S.rtWritten && S.strict !== 'off') writtenCorrections(text, b);
  } else if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
    const b = rtBubble(ev.item_id, 'ai'); if (b) { b.querySelector('.txt').textContent += ev.delta || ''; scrollDown(rtLog()); }
  } else if (t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done') {
    const b = rtBubble(ev.item_id, 'ai'); if (b && ev.transcript) b.querySelector('.txt').textContent = ev.transcript;
    if (ev.transcript) { history.push({ role: 'assistant', content: ev.transcript }); history = history.slice(-16); liveTalkTurnDone(ev.transcript); }
  } else if (t === 'response.done') {
    const u = ev.response && ev.response.usage;
    if (u) {
      const p = price('rt', S.rtModel);
      const inD = u.input_token_details || {}, outD = u.output_token_details || {};
      const cD = inD.cached_tokens_details || {};
      const cA = cD.audio_tokens || 0, cT = cD.text_tokens || 0;
      const usd = (Math.max(0, (inD.audio_tokens || 0) - cA) * p.ain + cA * p.acached +
        Math.max(0, (inD.text_tokens || 0) - cT) * p.tin + cT * p.tcached +
        (outD.audio_tokens || 0) * p.aout + (outD.text_tokens || 0) * p.tout) / 1e6;
      addCost('rt', usd);
    }
    if (ev.response && ev.response.status === 'failed') {
      const err = ev.response.status_details?.error?.message; if (err) setStatus(err, true);
    }
  } else if (t === 'error') {
    setStatus((ev.error && ev.error.message) || 'Realtime error.', true);
  }
}
async function writtenCorrections(text, afterEl) {
  if (isOpenTalk()) return;
  try {
    const out = await chatJSON([
      { role: 'system', content: [
        prompt('checker'),
        'Return only JSON: {"mistakes":[{"wrong":"...","right":"...","why":"short explanation"}],"corrected":"whole message corrected, or empty"}',
      ].join('\n') },
      { role: 'user', content: text },
    ], 300);
    const mistakes = Array.isArray(out.mistakes) ? out.mistakes.filter((m) => m && (m.wrong || m.right)) : [];
    if (!mistakes.length) return; // stay quiet in a live call when there is nothing to fix
    const tmp = el('div'); renderFix(tmp, out);
    const card = tmp.firstChild;
    if (afterEl && afterEl.parentNode) afterEl.after(card); else $('log').appendChild(card);
    persistChat();
  } catch { /* written corrections are optional */ }
}
function sendTypedRealtime(text) {
  const st = rt; if (!st || !st.dc || st.dc.readyState !== 'open') return false;
  bubble($('log'), 'me', text, { typed: true });
  st.dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  st.dc.send(JSON.stringify({ type: 'response.create' }));
  if (!liveTalkUserSaid(text) && S.rtWritten && S.strict !== 'off') writtenCorrections(text, $('log').lastElementChild);
  return true;
}

/* ---------- the orb ---------- */
const orb = { c: null, ctx: null, w: 0, t: 0, lvl: 0, reduced: false };
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function hexA(hex, a) {
  const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function setupOrb() {
  orb.c = $('orbCanvas'); orb.ctx = orb.c.getContext('2d');
  orb.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const resize = () => {
    const r = orb.c.getBoundingClientRect(); const d = Math.min(2.5, window.devicePixelRatio || 1);
    orb.w = r.width; orb.c.width = Math.round(r.width * d); orb.c.height = Math.round(r.height * d);
    orb.ctx.setTransform(d, 0, 0, d, 0, 0);
  };
  new ResizeObserver(resize).observe(orb.c); resize();
  requestAnimationFrame(drawOrb);
}
function drawOrb(ts) {
  const { ctx, w } = orb;
  if (w) {
    orb.t = ts / 1000;
    const you = cssVar('--you') || '#4fd8c4', ai = cssVar('--ai') || '#b7a2ff', fix = cssVar('--fix') || '#ffc66d';
    const live = phase === 'rec' ? levels.mic : phase === 'call' ? Math.max(levels.mic, levels.ai) :
      phase === 'speak' ? 0.25 + 0.2 * Math.abs(Math.sin(orb.t * 5.3)) * Math.abs(Math.sin(orb.t * 2.1)) : 0;
    orb.lvl += (live - orb.lvl) * 0.25;
    const lead = phase === 'rec' || (phase === 'call' && levels.mic > levels.ai) ? you : phase === 'think' || phase === 'connecting' ? fix : ai;
    const c = w / 2, base = w * 0.345 * (1 + orb.lvl * 0.22);
    const speed = orb.reduced ? 0 : (phase === 'think' || phase === 'connecting' ? 2.4 : 0.7);
    ctx.clearRect(0, 0, w, w);
    // soft halo
    const halo = ctx.createRadialGradient(c, c, base * 0.6, c, c, w / 2);
    halo.addColorStop(0, hexA(lead.startsWith('#') ? lead : '#b7a2ff', 0.28 + orb.lvl * 0.3));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(c, c, w / 2, 0, Math.PI * 2); ctx.fill();
    // three drifting layers
    const layers = [[ai, 0, 1.0], [you, 2.1, 0.9], [lead, 4.2, 0.78]];
    layers.forEach(([col, ph, sc], li) => {
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const wob = (orb.reduced ? 0 : 1) * (0.045 + orb.lvl * 0.09) *
          (Math.sin(a * 3 + orb.t * speed * (1 + li * 0.3) + ph) + 0.6 * Math.sin(a * 5 - orb.t * speed * 1.3 + ph * 1.7));
        const r = base * sc * (1 + wob);
        const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      const g = ctx.createRadialGradient(c - base * 0.35, c - base * 0.4, base * 0.1, c, c, base * sc * 1.1);
      const cc = col.startsWith('#') ? col : '#b7a2ff';
      g.addColorStop(0, hexA(cc, 0.95)); g.addColorStop(1, hexA(cc, 0.55));
      ctx.fillStyle = g; ctx.globalAlpha = li === 0 ? 1 : 0.62; ctx.fill(); ctx.globalAlpha = 1;
    });
    // glossy highlight
    const hl = ctx.createRadialGradient(c - base * 0.35, c - base * 0.45, 0, c - base * 0.35, c - base * 0.45, base * 0.7);
    hl.addColorStop(0, 'rgba(255,255,255,.45)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(c, c, base * 0.98, 0, Math.PI * 2); ctx.fill();
  }
  requestAnimationFrame(drawOrb);
}

/* ---------- settings ---------- */
function saveSettings() { store.set('ens.settings', S); renderEngineChip(); }
function openSettings() { renderTotals(); renderPrices(); renderPromptEditor(); try { $('settings').showModal(); } catch { $('settings').setAttribute('open', ''); } }
function fillSelect(id, ids, current, labelFn) {
  const sel = $(id); sel.innerHTML = '';
  const list = Array.from(new Set([current, ...ids]));
  list.forEach((m) => { const o = el('option'); o.value = m; o.textContent = labelFn ? labelFn(m) : m; if (m === current) o.selected = true; sel.appendChild(o); });
}
function fillGrouped(id, groups, current) {
  const sel = $(id); sel.innerHTML = '';
  let found = false;
  groups.forEach(([label, ids, labelFn]) => {
    const g = el('optgroup'); g.label = label;
    ids.forEach((m) => { const o = el('option'); o.value = m; o.textContent = labelFn(m); if (m === current) { o.selected = true; found = true; } g.appendChild(o); });
    if (ids.length) sel.appendChild(g);
  });
  if (!found && current) { const o = el('option'); o.value = current; o.textContent = current; o.selected = true; sel.prepend(o); }
}
function modelLists() {
  const avail = availableModels || [];
  const okChat = (m) => /^gpt-(4o-mini|4\.1-(mini|nano)|5(\.\d+)?-(mini|nano)|6[\w.-]*)$/.test(m) && !/audio|realtime|tts|transcribe|search|image|codex|pro/.test(m);
  const known = Object.keys(CHAT_MODELS).filter((m) => !availableModels || avail.includes(m));
  const chat = Array.from(new Set([...known, ...avail.filter(okChat)]));
  const stt = Object.keys(STT_MODELS).filter((m) => !availableModels || avail.includes(m)).concat(avail.filter((m) => /transcribe$/.test(m) && !STT_MODELS[m] && !/diariz/.test(m)));
  const rtm = Object.keys(RT_MODELS).filter((m) => !availableModels || avail.includes(m)).concat(avail.filter((m) => /^gpt-realtime[\w.-]*$/.test(m) && !RT_MODELS[m] && !/translate|whisper|\d{4}-\d{2}-\d{2}/.test(m)));
  return { chat: chat.length ? chat : Object.keys(CHAT_MODELS), stt: stt.length ? stt : Object.keys(STT_MODELS), rt: rtm.length ? rtm : Object.keys(RT_MODELS) };
}
function chatLabel(m) {
  const p = price('chat', m); const n = (CHAT_MODELS[m] || {}).note;
  if (p.unknown && !(S.prices[m] && (S.prices[m].in || S.prices[m].out))) return `${m}  (price not set: enter it in Settings)`;
  return `${m}  ($${p.in} / $${p.out})${n ? ', ' + n : ''}`;
}
function rtLabel(m) { const p = price('rt', m); return `${m}  (audio $${p.ain} / $${p.aout})`; }
function fillModelSelects() {
  const L = modelLists();
  const G = geminiLists();
  if (S.provider === 'gemini') {
    fillSelect('chatModel', G.text, S.chatModel, gemLabel);
    fillSelect('sttModel', G.text, S.sttModel, gemLabel);
  } else {
    fillSelect('chatModel', L.chat, S.chatModel, chatLabel);
    fillSelect('sttModel', L.stt, S.sttModel, (m) => `${m}  ($${price('stt', m).min}/min)`);
  }
  fillSelect('gLiveModel', G.live, S.gLiveModel, (m) => `${m}  (${S.gemFree ? 'free tier' : '$0.005 / $0.018 per min'})`);
  fillSelect('gVoice', GEMINI_VOICES, S.gVoice);
  fillSelect('rtModel', L.rt, S.rtModel, rtLabel);
  fillSelect('openaiVoice', TTS_VOICES, S.openaiVoice);
  fillSelect('rtVoice', RT_VOICES, S.rtVoice);
}
function renderPrices() {
  const chatRows = isGem(S.chatModel) ? [[S.chatModel, 'in', 'Gemini chat input, per 1M (paid tier)', 'gem'], [S.chatModel, 'out', 'Gemini chat output, per 1M (paid tier)', 'gem']]
    : [[S.chatModel, 'in', 'Chat input, per 1M tokens', 'chat'], [S.chatModel, 'out', 'Chat output, per 1M tokens', 'chat']];
  const sttRows = isGem(S.sttModel) ? [[S.sttModel, 'ain', 'Gemini audio input, per 1M (paid tier)', 'gem']] : [[S.sttModel, 'min', 'Speech to text, per minute', 'stt']];
  const rows = S.provider === 'gemini' ? [
    ...chatRows, ...sttRows,
    [S.gLiveModel, 'inMin', 'Live call audio in, per minute (paid tier)', 'glive'], [S.gLiveModel, 'outMin', 'Live call audio out, per minute (paid tier)', 'glive'],
  ] : [
    ...chatRows, ...sttRows, [TTS_MODEL, 'min', 'OpenAI voice, per minute', 'tts'],
    [S.rtModel, 'ain', 'Realtime audio in, per 1M', 'rt'], [S.rtModel, 'acached', 'Realtime cached audio in, per 1M', 'rt'],
    [S.rtModel, 'aout', 'Realtime audio out, per 1M', 'rt'], [S.rtModel, 'tin', 'Realtime text in, per 1M', 'rt'],
    [S.rtModel, 'tout', 'Realtime text out, per 1M', 'rt'],
  ];
  const g = $('priceGrid'); g.innerHTML = '';
  rows.forEach(([model, key, label, kind]) => {
    const f = el('label', 'field');
    f.innerHTML = `<span>${label}<br><small>${esc(model)}</small></span>`;
    const cur = kind === 'gem' ? gPrice(model) : kind === 'glive' ? gLivePrice() : price(kind, model);
    const inp = el('input'); inp.type = 'number'; inp.step = 'any'; inp.min = '0'; inp.value = cur[key];
    inp.addEventListener('change', () => {
      S.prices[model] = Object.assign({}, S.prices[model], { [key]: Number(inp.value) }); saveSettings(); fillModelSelects();
    });
    f.appendChild(inp); g.appendChild(f);
  });
}
function syncVoiceUI() { const oa = S.voiceEngine === 'openai'; $('openaiVoiceWrap').hidden = !oa; $('deviceVoiceWrap').hidden = oa; $('voiceEngine').value = S.voiceEngine; }
function syncProviderUI() {
  document.querySelectorAll('[data-prov]').forEach((n) => {
    const hide = n.dataset.prov !== S.provider;
    n.hidden = hide;
    if (n.tagName === 'OPTION') n.disabled = hide;
  });
  fillModelSelects();
}
function syncTalkMode() {
  document.querySelectorAll('#talkModes .tm').forEach((b) => b.setAttribute('aria-checked', b.dataset.tm === S.talkMode ? 'true' : 'false'));
  $('talkModes').hidden = mode !== 'talk';
}
function syncTargetHint() {
  if (target) return;
  $('target').textContent = usesCall() ? 'Tap the circle to start. The coach will ask what you want to practice.' : 'Tap Next sentence to begin.';
}
function syncEngineUI() {
  syncTargetHint();
  document.querySelectorAll('input[name="engine"]').forEach((r) => { r.checked = r.value === S.engine; });
  // show only the settings of the engine in use; speed and practice settings stay visible
  $('turnGroup').hidden = isCallEngine();
  $('rtGroup').hidden = !(S.provider === 'openai' && S.engine === 'realtime');
  $('gliveGroup').hidden = !(S.provider === 'gemini' && S.engine === 'glive');
  renderEngineChip(); if (phase === 'idle') setPhase('idle');
}
function idleStatus() {
  const haveKey = S.provider === 'gemini' ? gKey : apiKey;
  setStatus(haveKey ? (usesCall() ? (mode === 'talk' ? 'Tap the circle to start a live call, or type below.' : 'Tap the circle to start. The coach says a sentence, you repeat it.') : 'Tap the circle and speak, or type below.')
    : `Start by adding your ${S.provider === 'gemini' ? 'Gemini' : 'OpenAI'} key in Settings.`);
}
function syncHandsFree() { $('handsFreeBtn').setAttribute('aria-pressed', S.handsFree ? 'true' : 'false'); $('handsFree').checked = !!S.handsFree; }

async function checkKey() {
  const hint = $('keyHint');
  if (!apiKey) { hint.className = 'hint bad'; hint.textContent = 'Paste a key first.'; return; }
  hint.className = 'hint'; hint.textContent = 'Checking...';
  try {
    const list = await fetchModels();
    fillModelSelects();
    const rtOk = list.some((m) => /realtime/.test(m));
    hint.className = 'hint ok';
    hint.textContent = `The key works. ${list.length} models available${rtOk ? ', realtime included' : ', no realtime model on this key'}.`;
  } catch (e) { hint.className = 'hint bad'; hint.textContent = e.message; }
}

async function checkGeminiKey() {
  const hint = $('gKeyHint');
  if (!gKey) { hint.className = 'hint bad'; hint.textContent = 'Paste a Gemini key first.'; return; }
  hint.className = 'hint'; hint.textContent = 'Checking...';
  try {
    const list = await fetchGeminiModels();
    fillModelSelects();
    const live = list.filter((m) => /live|native-audio/.test(m.id) && !/translate|transcribe/.test(m.id)).length;
    hint.className = 'hint ok';
    hint.textContent = `The Gemini key works. ${list.length} models, ${live} of them for Live calls.`;
  } catch (e) { hint.className = 'hint bad'; hint.textContent = e.message; }
}

const PROMPT_GROUPS = [
  ['Conversation tab', ['liveConversation', 'liveCorrections', 'conversation', 'openTalk']],
  ['Repeat after me tab', ['liveRepeat', 'repeatSentence']],
  ['Both tabs', ['checker', 'transcription']],
];
function promptLabel(k) { return (PROMPTS.find((p) => p[0] === k) || [k, k])[1]; }
/* One box per instruction, each with its own Save and Reset. */
function renderPromptEditor() {
  const list = $('promptList'); if (!list) return;
  const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  list.innerHTML = '';
  PROMPT_GROUPS.forEach(([title, keys]) => {
    list.appendChild(el('h4', 'prompt-group', esc(title)));
    keys.forEach((key) => {
      const edited = typeof promptEdits[key] === 'string';
      const d = el('details', 'prompt-box'); d.dataset.key = key; if (open.has(key)) d.open = true;
      d.innerHTML = `<summary>${esc(promptLabel(key))}<span class="badge${edited ? ' on' : ''}">${edited ? 'your version' : 'default'}</span></summary>`;
      const ta = el('textarea'); ta.rows = 10; ta.spellcheck = false; ta.setAttribute('aria-label', promptLabel(key));
      try { ta.value = rawPrompt(key); } catch { ta.value = ''; }
      const msg = el('p', 'hint');
      const row = el('div', 'row-btns');
      const save = el('button', 'pill-btn strong', 'Save'); save.type = 'button';
      const reset = el('button', 'pill-btn', 'Reset to default'); reset.type = 'button';
      save.onclick = () => {
        if (!ta.value.trim()) { msg.className = 'hint bad'; msg.textContent = 'Empty instructions cannot be saved. Use Reset instead.'; return; }
        promptEdits[key] = ta.value; store.set('ens.prompts', promptEdits);
        liveSettingsChanged(); renderPromptEditor();
        const m = $('promptList').querySelector(`details[data-key="${key}"] .hint`); if (m) { m.className = 'hint ok'; m.textContent = 'Saved. Used from now on.'; }
      };
      reset.onclick = async () => {
        delete promptEdits[key]; store.set('ens.prompts', promptEdits);
        try { await loadPromptDefaults(true); } catch (e) { msg.className = 'hint bad'; msg.textContent = e.message; return; }
        liveSettingsChanged(); renderPromptEditor();
        const m = $('promptList').querySelector(`details[data-key="${key}"] .hint`); if (m) { m.className = 'hint ok'; m.textContent = 'Back to the default from GitHub.'; }
      };
      row.append(save, reset); d.append(ta, row, msg); list.appendChild(d);
    });
  });
  if (!promptDefaults) $('promptState').textContent = 'The defaults have not loaded yet. Check the internet connection.';
}
function bindPrompts() {
  let armed = null;
  $('promptResetAll').addEventListener('click', async () => {
    const b = $('promptResetAll');
    if (!armed) { b.textContent = 'Tap again to reset all'; armed = setTimeout(() => { armed = null; b.textContent = 'Reset all instructions'; }, 3000); return; }
    clearTimeout(armed); armed = null; b.textContent = 'Reset all instructions';
    promptEdits = {}; store.set('ens.prompts', promptEdits);
    try { await loadPromptDefaults(true); } catch (e) { $('promptState').className = 'hint bad'; $('promptState').textContent = e.message; return; }
    renderPromptEditor(); $('promptState').className = 'hint ok'; $('promptState').textContent = 'All instructions are back to the defaults from GitHub.';
    liveSettingsChanged();
  });
  renderPromptEditor();
}

function bindSettings() {
  bindPrompts();
  $('gKey').value = gKey;
  $('gKey').addEventListener('change', () => { gKey = $('gKey').value.trim(); store.set('ens.gkey', gKey); if (gKey) checkGeminiKey(); idleStatus(); });
  $('checkGKey').addEventListener('click', () => { gKey = $('gKey').value.trim(); store.set('ens.gkey', gKey); checkGeminiKey(); });
  document.querySelectorAll('input[name="provider"]').forEach((r) => {
    r.checked = r.value === S.provider;
    r.addEventListener('change', () => {
      if (!r.checked) return;
      endAnyCall(); stopSpeaking();
      S.provider = r.value; applyProvider(); saveSettings();
      syncProviderUI(); syncEngineUI(); syncVoiceUI(); renderPrices(); renderTotals(); idleStatus();
    });
  });
  $('gemFree').checked = !!S.gemFree;
  $('gemFree').addEventListener('change', () => { S.gemFree = $('gemFree').checked; saveSettings(); fillModelSelects(); renderPrices(); renderTotals(); renderSpend(); });
  $('forgetGKey').addEventListener('click', () => { gKey = ''; store.del('ens.gkey'); $('gKey').value = ''; $('gKeyHint').className = 'hint'; $('gKeyHint').textContent = 'Gemini key removed from this device.'; });
  $('apiKey').value = apiKey;
  $('apiKey').addEventListener('change', () => { apiKey = $('apiKey').value.trim(); store.set('ens.key', apiKey); if (apiKey) checkKey(); });
  $('checkKey').addEventListener('click', () => { apiKey = $('apiKey').value.trim(); store.set('ens.key', apiKey); checkKey(); });
  ['level', 'strict', 'explainLang', 'replyLen', 'voiceEngine', 'chatModel', 'sttModel', 'rtModel', 'openaiVoice', 'rtVoice', 'gLiveModel', 'gVoice'].forEach((id) => {
    const n = $(id); if (n.tagName === 'SELECT' && !n.options.length) return;
    n.value = S[id];
    n.addEventListener('change', () => {
      S[id] = n.value;
      const g = S.provider === 'gemini';
      if (id === 'chatModel') S[g ? 'gChat' : 'oaChat'] = n.value;
      if (id === 'sttModel') S[g ? 'gStt' : 'oaStt'] = n.value;
      saveSettings(); syncVoiceUI(); renderPrices();
      if (['level', 'strict', 'replyLen', 'explainLang'].includes(id)) liveSettingsChanged();
    });
  });
  ['sayCorrections', 'autoStop', 'handsFree', 'speakTyped', 'rtWritten', 'keepMic'].forEach((id) => {
    const n = $(id); n.checked = !!S[id];
    n.addEventListener('change', () => { S[id] = n.checked; saveSettings(); syncHandsFree(); if (id === 'sayCorrections') liveSettingsChanged(); if (id === 'keepMic' && !n.checked && !rec && !rt && !gl) releaseMic(true); });
  });
  document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', () => {
    if (r.checked) { endAnyCall(); S.engine = r.value; S[S.provider === 'gemini' ? 'gEngine' : 'oaEngine'] = r.value; saveSettings(); syncEngineUI(); idleStatus(); }
  }));
  $('deviceVoice').addEventListener('change', () => { S.deviceVoice = $('deviceVoice').value; saveSettings(); });
  $('rate').value = S.rate; $('rateVal').textContent = Number(S.rate).toFixed(2);
  $('rate').addEventListener('input', () => { S.rate = Number($('rate').value); $('rateVal').textContent = S.rate.toFixed(2); saveSettings(); });
  $('rate').addEventListener('change', () => liveSettingsChanged());
  $('testVoice').addEventListener('click', () => { unlockAudio(); stopSpeaking(); speak('Hi! This is how I sound. Shall we practice some English?'); });
  $('resetPrices').addEventListener('click', () => { S.prices = {}; saveSettings(); renderPrices(); fillModelSelects(); });
  $('resetTotals').addEventListener('click', () => { Object.keys(totals).forEach((k) => { totals[k] = 0; }); store.set('ens.totals', totals); renderTotals(); renderSpend(); });
  $('forgetKey').addEventListener('click', () => { apiKey = ''; store.del('ens.key'); $('apiKey').value = ''; $('keyHint').className = 'hint'; $('keyHint').textContent = 'Key removed from this device.'; });
  $('ver').textContent = VERSION;
  syncProviderUI(); syncVoiceUI(); syncHandsFree(); syncEngineUI();
}

/* ---------- wiring ---------- */
function onOrb() {
  unlockAudio(); handsFreeCancelled = false;
  if (usesCall()) {
    if (phase === 'call' || phase === 'connecting') endAnyCall();
    else { stopSpeaking(); if (S.engine === 'glive') startGeminiCall(mode); else startCall(mode); }
    return;
  }
  if (phase === 'rec') { stopRec(); return; }
  if (phase === 'think') return;
  if (phase === 'speak') { stopSpeaking(); setPhase('idle'); }
  startRec();
}
function switchMode(m) {
  if (m === mode) return;
  endAnyCall();
  if (phase === 'rec' && rec) { rec.heard = false; stopRec(); }
  stopSpeaking(); mode = m; setPhase('idle');
  document.querySelectorAll('.seg').forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  document.querySelector('.segmented').dataset.mode = m;
  $('talkView').hidden = m !== 'talk'; $('repeatView').hidden = m !== 'repeat'; syncTalkMode();
  syncTargetHint();
  $('composer').hidden = m !== 'talk';
  setStatus(m === 'talk' ? 'Tap the circle and speak, or type below.' : (target ? 'Tap the circle and repeat the sentence.' : 'Tap Next sentence to begin.'));
  if (m === 'repeat' && usesCall()) setStatus('Tap the circle to start. The coach says a sentence, you repeat it, it tells you how it went.');
}
async function onTyped(ev) {
  ev.preventDefault();
  const text = $('typed').value.trim(); if (!text) return;
  unlockAudio();
  if (rt) { if (sendTypedRealtime(text)) $('typed').value = ''; return; }
  if (gl) { if (sendTypedGemini(text)) $('typed').value = ''; return; }
  if (!needKeys([S.chatModel])) return;
  if (phase === 'rec' || phase === 'think') return;
  stopSpeaking(); $('typed').value = '';
  try { await handleTalk(text, true); } catch (e) { setPhase('idle'); setStatus(e.message, true); }
}

/* iPhone Safari ignores user-scalable=no, so pinch zoom is blocked through its own gesture events. */
function lockZoom() {
  const stop = (e) => e.preventDefault();
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, stop, { passive: false }));
  document.addEventListener('touchmove', (e) => { if ((e.scale !== undefined && e.scale !== 1) || e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('dblclick', stop, { passive: false });
}
/* Keep the layout inside the visible area when the keyboard opens (iOS does not shrink 100dvh for it). */
function fitToViewport() {
  const vv = window.visualViewport; if (!vv || !IS_IOS) return; // Android resizes the layout itself (interactive-widget)
  const apply = () => {
    document.documentElement.style.setProperty('--app-h', Math.round(vv.height) + 'px');
    if (window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply); apply();
}
function registerWorker() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app works without it */ });
  }
}

/* ---------- how to create a key: step-by-step window ---------- */
const GUIDES = {
  gemini: {
    title: 'Create a free Gemini key',
    url: 'https://aistudio.google.com/api-keys', site: 'aistudio.google.com/api-keys', open: 'Open Google AI Studio',
    intro: 'Free with a Google account, within Google\'s daily limits. Takes about a minute.',
    steps: [
      ['Open Google AI Studio with the button above and sign in with your Google account. The first time, accept the terms.'],
      ['Tap <b>Create API key</b> at the top right.', 'guide/gemini-1.png', 'API Keys page with the Create API key button marked'],
      ['Give the key a name, for example <b>EN Speaking</b>. Keep <b>Default Gemini Project</b>. Tap <b>Create key</b>.', 'guide/gemini-2.png', 'Create a new key window with the name box and the Create key button marked'],
      ['In the key\'s row, tap the <b>copy</b> icon. Check that <b>Billing Tier</b> says <b>Free tier</b>. Do not tap <b>Set up billing</b>: that turns on paid use.', 'guide/gemini-3.png', 'Key list with the copy icon, Free tier and Set up billing marked'],
      ['Come back here, paste the key into <b>Gemini key</b> and tap <b>Check</b>.'],
    ],
    note: 'On the free tier Google may use what you send to improve its products, and people may review it. Do not share private details while practicing.',
    field: 'gKey',
  },
  openai: {
    title: 'Create an OpenAI key',
    url: 'https://platform.openai.com/api-keys', site: 'platform.openai.com/api-keys', open: 'Open the OpenAI platform',
    intro: 'Paid per use. Turn by turn costs cents per hour; live calls cost more.',
    steps: [
      ['Open the OpenAI platform with the button above and sign in. OpenAI is prepaid: add a little credit under <b>Settings</b>, <b>Billing</b> (for example $5). You can also set a monthly budget for the project.'],
      ['On the API keys page, tap <b>Create new secret key</b>.', 'guide/openai-1.png', 'API keys page with the Create new secret key button marked'],
      ['Keep <b>Owned by: You</b>. Give it a name, for example <b>EN Speaking</b>. Keep <b>Default project</b> and <b>Permissions: All</b>. Tap <b>Create secret key</b>.', 'guide/openai-2.png', 'Create new secret key window with the name box and the Create secret key button marked'],
      ['Copy the key right away. OpenAI shows it only once.'],
      ['Come back here, paste the key into <b>OpenAI key</b> and tap <b>Check</b>.'],
    ],
    note: 'Keep the key to yourself: anyone who has it can spend your credit.',
    field: 'apiKey',
  },
};
function openGuide(kind) {
  const g = GUIDES[kind];
  $('guideTitle').textContent = g.title;
  $('guideBody').innerHTML =
    `<p class="guide-intro">${g.intro}</p>` +
    `<a class="guide-link" href="${g.url}" target="_blank" rel="noopener noreferrer"><span>${g.open}</span><small>${g.site}</small></a>` +
    '<ol class="guide-steps">' + g.steps.map(([t, img, alt]) =>
      `<li><p>${t}</p>${img ? `<div class="shot"><img src="${img}?v=2" alt="${esc(alt)}" loading="lazy"><span class="shot-hint">Tap to enlarge</span></div>` : ''}</li>`).join('') + '</ol>' +
    `<p class="hint">${g.note}</p>` +
    `<button type="button" class="pill-btn strong guide-done" data-field="${g.field}">I have my key</button>`;
  // tap a picture to see it full size (pinch zoom is off in this app)
  $('guideBody').querySelectorAll('.guide-steps img').forEach((im) => {
    im.addEventListener('click', () => { const z = im.closest('.shot'); z.classList.toggle('zoom'); });
  });
  $('guideBody').querySelector('.guide-done').onclick = (e) => { $('guide').close(); const f = $(e.target.dataset.field); if (f) f.focus(); };
  $('guideBody').scrollTop = 0;
  try { $('guide').showModal(); } catch { $('guide').setAttribute('open', ''); }
}
function setupGuide() {
  $('createGKey').addEventListener('click', () => openGuide('gemini'));
  $('createKey').addEventListener('click', () => openGuide('openai'));
  $('guideClose').addEventListener('click', () => $('guide').close());
  $('guide').addEventListener('click', (e) => { if (e.target === $('guide')) $('guide').close(); }); // tap outside closes
}

/* Android: offer "Install app" when Chrome allows it. */
let installEvent = null;
function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('installBtn').hidden = false; });
  window.addEventListener('appinstalled', () => { installEvent = null; $('installBtn').hidden = true; });
  $('installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt(); try { await installEvent.userChoice; } catch { /* ignore */ }
    installEvent = null; $('installBtn').hidden = true;
  });
}
/* Android back button closes Settings instead of leaving the app. */
function setupBackButton() {
  const H = window.history; // "history" in this file is the chat history
  ['settings', 'guide'].forEach((id) => {
    const dlg = $(id);
    new MutationObserver(() => { if (dlg.open) { try { H.pushState({ dlg: id }, ''); } catch { /* ignore */ } } }).observe(dlg, { attributes: true, attributeFilter: ['open'] });
    // closed with its own button: drop the history entry we added, without closing anything else
    dlg.addEventListener('close', () => { if (H.state && H.state.dlg === id) { ignorePop = true; H.back(); } });
  });
  let ignorePop = false;
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop = false; return; }
    if ($('guide').open) $('guide').close(); else if ($('settings').open) $('settings').close();
  });
}

function init() {
  lockZoom(); fitToViewport(); registerWorker(); setupInstall(); setupBackButton(); setupGuide();
  $('voiceEngine').options[0].textContent = `${DEVICE_VOICE} (free)`;
  $('deviceVoiceLabel').textContent = DEVICE_VOICE;
  fillModelSelects();
  bindSettings();
  restoreChat(); emptyState(); renderSpend();
  setupOrb();
  if ('speechSynthesis' in window) { fillDeviceVoices(); speechSynthesis.onvoiceschanged = fillDeviceVoices; }
  $('mic').addEventListener('click', onOrb);
  $('openSettings').addEventListener('click', openSettings);
  $('spendBtn').addEventListener('click', () => { openSettings(); });
  $('engineChip').addEventListener('click', () => { openSettings(); setTimeout(() => $('engineGroup').scrollIntoView({ block: 'start' }), 50); });
  $('replay').addEventListener('click', () => { if (lastSpoken) { unlockAudio(); stopSpeaking(); speak(lastSpoken); } });
  $('handsFreeBtn').addEventListener('click', () => {
    S.handsFree = !S.handsFree; saveSettings(); syncHandsFree(); handsFreeCancelled = !S.handsFree;
    setStatus(S.handsFree ? 'Hands-free is on: I listen again after each answer.' : 'Hands-free is off.');
  });
  document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  $('drillContinue').addEventListener('click', () => { unlockAudio(); stopSpeaking(); continueFromDrill(); });
  document.querySelectorAll('#talkModes .tm').forEach((b) => b.addEventListener('click', () => {
    if (S.talkMode === b.dataset.tm) return;
    S.talkMode = b.dataset.tm; saveSettings(); syncTalkMode(); liveSettingsChanged();
    if (isOpenTalk() && talkDrill) continueFromDrill();
    if (!rt && !gl) setStatus(isOpenTalk() ? 'Open talk: no corrections. Talk or ask anything.' : 'Practice: your mistakes will be corrected.');
  }));
  syncTalkMode();
  $('topic').addEventListener('change', () => liveSettingsChanged());
  $('composer').addEventListener('submit', onTyped);
  let delArmed = null;
  $('newChat').addEventListener('click', () => {
    const btn = $('newChat');
    if (!delArmed) {
      btn.textContent = 'Tap again to delete'; btn.classList.add('danger');
      delArmed = setTimeout(() => { delArmed = null; btn.textContent = 'Delete chat'; btn.classList.remove('danger'); }, 3000);
      return;
    }
    clearTimeout(delArmed); delArmed = null; btn.textContent = 'Delete chat'; btn.classList.remove('danger');
    endAnyCall(); stopSpeaking(); setPhase('idle');
    if (mode === 'repeat') {
      $('repeatLog').innerHTML = ''; target = null; attempts = 0;
      syncTargetHint(); $('focus').textContent = '';
      $('hearAgain').disabled = true; $('hearSlow').disabled = true;
      emptyState(); setStatus('Practice deleted.');
      return;
    }
    history = []; $('log').innerHTML = ''; store.del('ens.chat'); clearTalkDrill(); emptyState();
    setStatus('Chat deleted. Tap the circle and speak, or type below.');
  });
  $('log').addEventListener('click', (e) => {
    const b = e.target.closest('.play'); if (!b) return;
    unlockAudio(); stopSpeaking(); speak(b.dataset.say || b.parentNode.querySelector('.txt').textContent);
  });
  // In a Gemini Live repeat drill these buttons ask the coach instead of the turn-by-turn engine.
  const liveRepeat = () => (gl && gl.kind === 'repeat') || (rt && rt.kind === 'repeat');
  const geminiSayOrRt = (text) => (gl ? geminiSay(text) : rtSay(text));
  $('nextSentence').addEventListener('click', () => {
    handsFreeCancelled = false;
    if (liveRepeat()) { geminiSayOrRt('Next sentence, please.'); return; }
    if (S.engine === 'glive') { unlockAudio(); startGeminiCall('repeat'); return; }
    if (S.engine === 'realtime') { unlockAudio(); startCall('repeat'); return; }
    nextSentence();
  });
  $('hearAgain').addEventListener('click', () => {
    if (liveRepeat()) { geminiSayOrRt('Please say the same sentence again.'); return; }
    if (target) { unlockAudio(); stopSpeaking(); speak(target.sentence); }
  });
  $('hearSlow').addEventListener('click', () => {
    if (liveRepeat()) { geminiSayOrRt('Please say the same sentence again, slowly and clearly.'); return; }
    if (target) { unlockAudio(); stopSpeaking(); speak(target.sentence, Math.max(0.5, Number(S.rate) * 0.7)); }
  });
  $('toggleText').addEventListener('click', () => { hideText = !hideText; $('target').classList.toggle('blur', hideText); $('toggleText').textContent = hideText ? 'Show text' : 'Hide text'; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (mediaKeeper) mediaKeeper.pause(); setTimeout(() => { if (document.hidden) releaseMic(true); }, 0); handsFreeCancelled = true; if (phase === 'rec') stopRec(); endAnyCall('Call ended because the app went to the background.'); stopSpeaking(); }
  });
  setPhase('idle');
  idleStatus();
  if (apiKey && !availableModels) fetchModels().then(fillModelSelects).catch(() => {});
  if (gKey && !availableGemini) fetchGeminiModels().then(fillModelSelects).catch(() => {});
  loadPromptDefaults().then(() => { if ($('settings').open) renderPromptEditor(); }).catch(() => { /* cached copy is used */ });
}
init();
