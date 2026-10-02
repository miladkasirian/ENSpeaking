/* EN Speaking: spoken English practice with OpenAI.
   Engines:
     turn     - record -> speech-to-text -> chat model (JSON with corrections) -> voice
     realtime - WebRTC voice call with an OpenAI realtime model
   The API key lives only in this browser's localStorage. */
'use strict';

const VERSION = '2.19.3 (2026-10-02)';
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
  level: 'B2', strict: 2, explainLang: 'English', replyLen: 3,
  sayCorrections: true, autoStop: true, handsFree: false, speakTyped: true, keepMic: true, saveData: true, aiNoise: true,
  talkMode: 'open', // Conversation tab: 'practice' (corrections) or 'open' (free talk, no corrections)
  chatModel: 'gpt-4o-mini', sttModel: 'gpt-4o-mini-transcribe',
  voiceEngine: 'device', deviceVoice: '', openaiVoice: 'coral', accent: 'boston', tone: 'strangers', speed: 2, rate: 0.85, volume: 100,
  rtModel: 'gpt-realtime-2.1-mini', rtVoice: 'marin', rtWritten: true,
  gLiveModel: 'gemini-3.8-live', gVoice: 'Charon', gemFree: true,
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
// corrections used to be a list (all / major / off); it is now a 0 to 5 scale
if (typeof S.strict === 'string') S.strict = { all: 5, major: 2, off: 0 }[S.strict] ?? (Number(S.strict) || 5);
S.strict = Math.max(0, Math.min(5, Math.round(Number(S.strict))));
// reply length used to be short / medium; it is now a 1 to 5 scale
if (typeof S.replyLen === 'string') S.replyLen = { short: 1, medium: 2 }[S.replyLen] || Number(S.replyLen) || 1;
S.replyLen = Math.max(1, Math.min(5, Math.round(Number(S.replyLen))));
// speaking speed used to be a number (0.6 to 1.3); it is now a 1 to 5 scale, 3 = normal
const SPEED_RATES = [0, 0.7, 0.85, 1, 1.15, 1.3];
const SPEED_NAMES = ['', 'Very slow', 'Slow', 'Normal', 'Fast', 'Very fast'];
if (S.speed === undefined) { const r = Number(S.rate) || 1; S.speed = r <= 0.75 ? 1 : r < 0.95 ? 2 : r <= 1.1 ? 3 : r <= 1.2 ? 4 : 5; }
// new defaults (October 2026), applied once to settings saved before them
if (!S.defaults2) {
  Object.assign(S, { level: 'B2', strict: 2, replyLen: 3, speed: 2, talkMode: 'open', defaults2: true });
  store.set('ens.settings', S);
}
if (!S.defaults3) { S.accent = 'boston'; S.defaults3 = true; store.set('ens.settings', S); } // Boston accent by default, applied once
if (!S.defaults6) { S.saveData = true; S.aiNoise = true; S.defaults6 = true; store.set('ens.settings', S); } // data saver and AI noise removal on, applied once
if (!S.defaults4) { S.gVoice = 'Charon'; S.defaults4 = true; store.set('ens.settings', S); } // Charon voice by default, applied once
S.speed = Math.max(1, Math.min(5, Math.round(Number(S.speed)))); S.rate = SPEED_RATES[S.speed];
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
const IS_STANDALONE = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
const IS_IOS_SAFARI = IS_IOS && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(UA);
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
/* Keep the screen on during a live call: a locked iPhone stops the page and the microphone,
   so the call would end. (Locking it yourself still ends the call; iOS does not let web apps run locked.) */
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch { wakeLock = null; }
}
/* The speed setting, said the way a learner would ask for it. Live models follow a request in the
   conversation much better than a line in their instructions, so it goes with the first message of
   every call and with every settings change. */
function paceRequest() {
  return ['', 'Please speak very slowly with me, word by word, with short pauses, for the whole conversation.',
    'Please speak slowly with me for the whole conversation.', 'Please speak at a normal pace, without pausing between sentences.',
    'Please speak a bit faster, like a native speaker, in one smooth flow without pauses.', 'Please speak fast, at full native speed, in one smooth flow without pauses.'][S.speed] || '';
}
const withPace = (text) => [text, toneOf().ask, paceRequest(), ACCENT_ASK[S.accent] || ''].filter(Boolean).join(' ');
function setPhase(p) {
  phase = p;
  keepScreenOn(p === 'call' || p === 'connecting' || ((p === 'speak' || p === 'think') && !!(rt || gl)));
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
  $('log').querySelectorAll('.practice-pending').forEach((n) => n.classList.remove('practice-pending'));
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
  if (!anyLanguage()) fd.append('language', 'en'); // Open talk: let it detect Persian and other languages
  fd.append('response_format', 'json');
  fd.append('prompt', transcriptionPrompt());
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
    u.rate = rate; u.volume = Math.min(1, volGain());
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
    applyVolume();
    audioEl.play().catch(() => { setStatus('Tap Play again under the message to hear the answer.'); finish(); });
  });
}
async function speak(text, rate = Number(S.rate)) {
  if (!text) return;
  lastSpoken = text;
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
    // 48 kHz: the rate the AI noise removal works at (the browser converts to and from the hardware)
    if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; try { audioCtx = new AC({ sampleRate: 48000 }); } catch { audioCtx = new AC(); } }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
  return audioCtx;
}
/* One microphone stream for the whole visit. Safari asks for permission again when the mic has been
   off for about a minute, so between turns the mic is muted instead of closed (setting "keepMic").
   It is fully released when the app goes to the background. */
let micStream = null;
async function getMic() {
  clearTimeout(micIdleTimer);
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live')) {
    micStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    return micStream;
  }
  // voiceIsolation: ask for the system's voice isolation (keeps the human voice, removes background noise)
  // where the browser supports it; browsers that do not know it simply ignore it
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true } });
  return micStream;
}
/* Live calls always close the mic when they end, so the iPhone's orange mic dot goes off.
   Between Turn-by-turn recordings the mic is only muted for 20 s (setting "keepMic"), then closed. */
let micIdleTimer = null;
function releaseMic(force = false) {
  clearTimeout(micIdleTimer);
  if (!micStream) return;
  if (S.keepMic && !force && !document.hidden) {
    micStream.getAudioTracks().forEach((t) => { t.enabled = false; });
    micIdleTimer = setTimeout(() => { if (!rec && !rt && !gl) releaseMic(true); }, 20000);
    return;
  }
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
/* How picky corrections are: 0 = never correct, 5 = every mistake. */
const STRICT_NAMES = ['Off', 'Only serious', 'Important', 'All grammar', 'Grammar + unnatural', 'Every mistake'];
const STRICT_RULES = [
  '',
  'only mistakes so serious that the meaning is unclear or wrong. Ignore every other mistake',
  'only clear, important mistakes: wrong verb tense or verb form, wrong word order, and wrong words that change the meaning. Ignore articles, prepositions, plurals, small slips and style',
  'all grammar mistakes and wrong words, including articles, prepositions and plurals. Ignore phrasing that is correct but not perfectly natural',
  'all grammar and word mistakes, plus clearly unnatural phrasing a native speaker would not use. Ignore small style preferences',
  'every mistake: grammar, word choice, articles, prepositions, and any unnatural or non-native-sounding phrasing',
];
const corrOn = () => Number(S.strict) > 0;
const strictRule = () => STRICT_RULES[Number(S.strict)] ?? STRICT_RULES[5];
function tutorRules() {
  return corrOn()
    ? `Report ${strictRule()}. Do not report anything else.`
    : 'Do not report mistakes: always return an empty "mistakes" list, an empty "corrected" and an empty "spoken_fix".';
}
/* The settings are added by the code to every instruction, so they work even if the editable text was changed. */
function settingsRule(kind) {
  const lvl = `The learner's level is CEFR ${S.level}: use words and grammar that fit this level.`;
  if (kind === 'repeat') return `SETTINGS (always follow): ${lvl} Every sentence must be ${drillLength()}. ${speakingPace()} ${soundNatural()} ${accentRule()} ${toneOf().rule}`;
  if (kind === 'checker') return `SETTINGS (always follow): The learner's level is CEFR ${S.level}. ${tutorRules()}`;
  const len = `Reply length: ${REPLY_LEN[S.replyLen] || REPLY_LEN[1]}.`;
  let corr;
  if (isOpenTalk()) corr = 'Do not correct the learner at all.';
  else if (!corrOn()) corr = 'Do not correct the learner at all; never point out mistakes.';
  else if (kind === 'live' && !S.sayCorrections) corr = 'Do not correct the learner out loud.';
  else corr = `Correct ${strictRule()}.` + (S.strict < 5 ? ' Let every other mistake go without comment.' : '');
  return `SETTINGS (always follow, they override anything above): ${lvl} ${len} Corrections: ${corr} ${toneOf().rule}` + (kind === 'live' ? ' ' + speakingPace() + ' ' + soundNatural() + ' ' + accentRule() + ' If the learner asks you to speak slower or faster, do that for the rest of the call.' : '');
}
const REPLY_LEN = {
  1: 'SHORT: one or two short sentences, at most 25 words in total',
  2: 'MEDIUM: three to five sentences, about 40 to 70 words in total',
  3: 'LONGER: five to seven sentences, about 70 to 110 words in total',
  4: 'LONG: seven to ten sentences, about 110 to 160 words in total',
  5: 'VERY LONG: a full, rich answer of about 180 to 250 words, longer than a usual conversation turn',
};
const LEN_NAMES = ['', 'Short', 'Medium', 'Longer', 'Long', 'Very long'];
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
  if (docActive()) return "The conversation is about the learner's document, shown at the end of these instructions.";
  return t ? `Conversation topic: ${t}.` : 'Let the learner choose the topic. If they have nothing to say, suggest an everyday topic.';
}
function openingLine(kind) {
  const t = $('topic').value.trim();
  if (kind === 'drill') {
    return t ? `The learner wants to practice this situation: ${t}. Make every sentence fit it. Start right away with the first sentence.`
      : 'At the very start, greet the learner briefly and ask in one short sentence which real-life situation they want to practice, for example ordering at a cafe, a job interview, or a doctor visit. Wait for the answer, then make every sentence fit the situation they describe. If they describe their own situation in detail, use their details.';
  }
  if (docActive()) return docOpening();
  return t ? `The learner chose this topic or situation: ${t}. Start the conversation about it right away with a friendly question.`
    : 'At the very start, greet the learner briefly and ask in one short sentence what they want to talk about or which real-life situation they want to practice, for example a job interview, ordering food, or small talk with a neighbor. Then build the whole conversation around what they describe, using their own details.';
}
function promptVars(extra = {}) {
  const speakFix = corrOn() && S.sayCorrections;
  const scope = strictRule();
  const v = {
    level: S.level, explainLang: S.explainLang,
    replyLength: REPLY_LEN[S.replyLen] || REPLY_LEN[1],
    drillLength: drillLength(),
    speakingPace: speakingPace(),
    feedbackLength: ['', 'one short sentence, at most 15 words', 'two or three sentences', 'three or four sentences', 'four or five sentences', 'five or six sentences'][S.replyLen] || 'one short sentence',
    corrections: tutorRules(), correctionScope: scope,
    topic: topicLine('talk'), inputNote: '', opening: openingLine('talk'),
  };
  Object.assign(v, extra);
  if (v.spokenCorrections === undefined) {
    v.spokenCorrections = speakFix ? fillPrompt(rawPrompt('liveCorrections'), v) : 'Do not correct the learner out loud; just keep the conversation going.';
  }
  return v;
}
/* Open talk: the Conversation tab without corrections, in any language. */
const isOpenTalk = () => S.talkMode === 'open';
const anyLanguage = () => isOpenTalk() && mode === 'talk';
const LANG_ENGLISH = 'Speak only English.';
const LANG_FREE = 'The learner may speak Persian (Farsi), English, a mix of both, or any other language. Always understand them. Answer in the language they use or ask for: if they speak Persian, you may answer in Persian. When they ask how to say something in English, give natural American English and explain it in their language if that helps.';
function transcriptionPrompt() {
  return anyLanguage()
    ? 'Transcribe exactly what the speaker says, word for word. The speaker may use Persian (Farsi), English, or both in one sentence. Write Persian in Persian script and English in English. Do not translate.'
    : prompt('transcription');
}
function openTalkVars() {
  if (!isOpenTalk()) return { languageRule: LANG_ENGLISH };
  const note = fillPrompt(rawPrompt('openTalk'), {});
  return {
    corrections: note + ' Always return an empty "mistakes" list, an empty "corrected" and an empty "spoken_fix".',
    spokenCorrections: note,
    languageRule: anyLanguage() ? LANG_FREE : LANG_ENGLISH,
  };
}
function fillPrompt(text, vars) { return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)).replace(/\n{3,}/g, '\n\n').trim(); }
function prompt(key, extra) { return fillPrompt(rawPrompt(key), promptVars(extra)); }

/* Live voices cannot be sped up without changing pitch, so the speed setting is passed as an instruction,
   worded like a learner asking "speak slowly", which the live models follow well. */
/* How the partner sounds at every speed: a real American speaking, not text being read out. */
/* How the partner sounds: casual, spoken American. From normal speed up: no reading pauses at all. */
/* The kind of conversation (setting "tone"). casual: contractions and reductions like gonna and wanna fit. */
const NO_NICKNAMES = 'Never call the learner kid, buddy, pal, dude, bro, honey, sweetie or any other nickname.';
const TONES = {
  friends: { casual: true, ask: "Let's talk like two good friends.",
    rule: 'TONE: talk like two good adult friends hanging out: relaxed, warm, joking a little, everyday slang that friends use. You can be playful, but never call the learner kid or anything condescending.' },
  coworkers: { casual: true, ask: "Let's talk like two coworkers on a coffee break.",
    rule: 'TONE: talk like two friendly coworkers on a coffee break: casual and relaxed, but still professional and respectful, workplace small talk. ' + NO_NICKNAMES },
  strangers: { casual: true, ask: "Let's talk like two adults who just met.",
    rule: 'TONE: talk like two adults who have just met: friendly, casual and polite, never overly familiar, no slang that would be rude between strangers. ' + NO_NICKNAMES },
  academic: { casual: false, ask: "Let's talk like two people chatting at a university.",
    rule: 'TONE: talk like two colleagues or graduate students chatting at a university: conversational but thoughtful, clear and precise, using academic words where they fit naturally, polite and respectful. Avoid slang. ' + NO_NICKNAMES },
  natural: { casual: false, ask: '',
    rule: 'TONE: natural, neutral everyday American English: neither slangy nor formal, polite and friendly, the way a well-spoken adult talks to anyone. ' + NO_NICKNAMES },
  business: { casual: false, ask: "Let's talk in a formal business tone.",
    rule: 'TONE: formal business English, like a professional meeting or a call with a client: polite, clear, well structured, professional vocabulary, no slang and few contractions. Address the learner respectfully. ' + NO_NICKNAMES },
  interview: { casual: false, ask: "Let's talk like a job interview.",
    rule: 'TONE: like a job interview: professional, polite and encouraging, clear questions, no slang. ' + NO_NICKNAMES },
  service: { casual: false, ask: "Let's talk like a customer and a service worker.",
    rule: 'TONE: like a polite customer-service conversation (a store, a bank, a restaurant, a front desk): courteous, helpful phrases such as "How can I help you?" and "Would you like...". ' + NO_NICKNAMES },
  teacher: { casual: false, ask: "Talk to me like a friendly teacher.",
    rule: 'TONE: like a friendly, patient teacher with an adult student: warm, encouraging, clear and respectful. ' + NO_NICKNAMES },
};
const toneOf = () => TONES[S.tone] || TONES.strangers;
/* How the partner sounds: spoken English in the chosen tone. From normal speed up: no reading pauses at all. */
function soundNatural() {
  const t = toneOf();
  const base = 'DELIVERY: sound like a real American talking, not like someone reading text: fluent, connected speech with natural rhythm and intonation' +
    (t.casual ? ', contractions, linked words and natural reductions (gonna, wanna, kinda, gotta).' : ', contractions where they fit the tone.') +
    " Keep your words natural for the learner's level.";
  if (S.speed <= 2) return base + ' Because the learner asked for a slow pace, short pauses between sentences are fine, but it must still sound like natural talk.';
  return base + ' Keep talking in one smooth flow: no pauses between sentences, no breaths or gaps in the middle of a turn, run your sentences together the way a relaxed native speaker does.' +
    (S.speed >= 4 ? ' Speak quickly and keep the energy up.' : '');
}
/* Accents for the live voice. */
const ACCENTS = {
  general: '',
  boston: 'ACCENT: speak with a Boston accent: drop the r after vowels ("pahk the cah", "wicked smaht"), broad a, and use Boston words like "wicked" now and then.',
  texas: 'ACCENT: speak with a Texas accent: a friendly Southern drawl with stretched vowels ("y\'all", "fixin\' to", "might could") but keep the speaking speed the learner chose.',
  california: 'ACCENT: speak with a laid-back California accent: relaxed West Coast vowels and rhythm, casual words like "totally", "super" and "like" now and then.',
  newyork: 'ACCENT: speak with a New York City accent: dropped r after vowels, "cawfee" and "tawk" vowels, quick and direct delivery, NYC expressions now and then.',
  florida: 'ACCENT: speak with a South Florida (Miami) accent: relaxed rhythm with a light Spanish-influenced lilt.',
};
const ACCENT_ASK = { general: '', boston: 'Talk to me with a Boston accent.', texas: 'Talk to me with a Texas accent.', california: 'Talk to me with a California accent.', newyork: 'Talk to me with a New York accent.', florida: 'Talk to me with a South Florida accent.' };
const accentRule = () => ACCENTS[S.accent] || '';
function speakingPace() {
  return [
    '',
    'SPEED: speak VERY slowly in every turn, as if the learner just asked "please speak very slowly": clearly pronounce every word and pause briefly between phrases and sentences.',
    'SPEED: speak slowly in every turn, as if the learner just asked "please speak slowly": clear words and a short pause between sentences.',
    'SPEED: speak at a natural, normal conversational pace.',
    'SPEED: speak a little faster than normal in every turn, like a fluent native speaker: smooth, connected speech with words linked together.',
    'SPEED: speak fast in every turn, at the full natural speed of a fluent American adult: smooth, connected, flowing speech with linked words. Never sound like you are reading.',
  ][S.speed] || 'Speak clearly, at a natural pace.';
}
/* Drill sentence length follows both the level and the Short/Medium setting. */
function drillLength() {
  const t = {
    1: { A2: '4 to 7 words', B1: '5 to 9 words', B2: '6 to 10 words', C1: '7 to 12 words' },
    2: { A2: '6 to 10 words', B1: '8 to 13 words', B2: '10 to 16 words', C1: '12 to 20 words' },
    3: { A2: '8 to 12 words', B1: '10 to 15 words', B2: '12 to 18 words', C1: '14 to 22 words' },
    4: { A2: '10 to 14 words', B1: '12 to 18 words', B2: '15 to 22 words', C1: '18 to 26 words' },
    5: { A2: '12 to 16 words', B1: '15 to 22 words', B2: '18 to 26 words', C1: '22 to 30 words' },
  }[S.replyLen] || {};
  return t[S.level] || t.B1 || '5 to 9 words';
}
function talkSystemPrompt(typed) {
  return [
    prompt('conversation', { ...openTalkVars(),
      inputNote: typed ? 'The learner typed this message. Treat it as conversation practice; ignore capitalization and small typos.'
        : "This is spoken practice. The message is a speech-to-text transcript, so ignore punctuation, capitalization and spelling. If a word looks like a speech-recognition slip rather than the learner's own mistake, ignore it.",
    }),
    settingsRule('talk') + docBlock('chat'),
    'Return only a JSON object with these keys:',
    '{"mistakes":[{"wrong":"their exact words","right":"corrected words","why":"short explanation"}],',
    '"corrected":"their message with only the reported mistakes fixed and everything else kept as they said it, or empty if no mistakes",',
    '"spoken_fix":"if there were mistakes, a very short recast to say aloud, like: You could say, I went there yesterday. Otherwise empty",',
    '"reply":"your reply"}',
  ].join('\n');
}
function renderFix(log, out) {
  if (!corrOn()) return [];
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
/* Background noise often comes back from speech detection as a filler sound or a few symbols. */
function isNoise(text) {
  // only empty or symbol-only text; short answers like "uh-huh", "mm-hmm" or "oh" are real answers and stay
  const t = String(text || '').trim();
  return !t || !/\p{L}/u.test(t);
}
/* Is this "what I heard" really the partner's own voice coming back from the speaker?
   True when the words appear, in order, in what the partner just said. A sentence you are
   practicing is never treated as echo, since you are meant to repeat it. */
function isEcho(text, aiTexts) {
  const mine = words(text); if (!mine.length) return false;
  if (talkDrill && mentions(text, talkDrill.sentence, 0.5)) return false;
  return aiTexts.some((t) => {
    const ai = words(t || ''); if (!ai.length) return false;
    let best = 0; // longest run of my words found in a row in the partner's words
    for (let i = 0; i < ai.length; i++) for (let j = 0; j < mine.length; j++) {
      let k = 0; while (i + k < ai.length && j + k < mine.length && ai[i + k] === mine[j + k]) k++;
      if (k > best) best = k;
    }
    // short: only if it is exactly how the partner's turn began (the part of its voice that leaks back);
    // longer: a run of at least 3 of its words in a row covering almost all of what was heard
    if (mine.length <= 3) return mine.every((w, i) => ai[i] === w);
    return best >= 3 && best / mine.length >= 0.85;
  });
}
function bubble(log, who, text, opts = {}) {
  const b = el('div', 'msg ' + (who === 'me' ? 'me' : 'ai') + (opts.pending ? ' pending' : ''));
  b.innerHTML = `<div class="who">${who === 'me' ? (opts.typed ? 'You wrote' : 'I heard') : 'Partner'}</div><div class="txt" dir="auto">${esc(text)}</div>`;
  if (opts.play) {
    const p = el('button', 'play', 'Play again'); p.type = 'button'; p.dataset.say = text;
    b.appendChild(p);
  }
  log.appendChild(b); scrollDown(log);
  return b;
}
async function handleTalk(text, typed) {
  const log = $('log'); clearEmpty(log);
  const mine = bubble(log, 'me', text, { typed });
  docHeard(text);
  if (talkDrill && practiceLoop()) {
    mine.classList.add('practice-try');
    const pct = attemptCard(log, talkDrill.sentence, text, ++talkDrill.tries);
    const q = talkDrill.question ? ' ' + talkDrill.question : '';
    if (pct === 100) { await speak('Good. Say it once more, or tap OK, continue.' + q); setStatus('Good. Say it again, or tap OK, continue.'); }
    else { await speak('Try again. ' + talkDrill.sentence + q, Number(S.rate) * 0.9); setStatus('Try again, or tap OK, continue.'); }
    if (!typed) continueHandsFree();
    return;
  }
  setPhase('think'); setStatus('Thinking...');
  const prevAi = [...history].reverse().find((m) => m.role === 'assistant');
  history.push({ role: 'user', content: text }); history = history.slice(-16);
  const out = await chatJSON([{ role: 'system', content: talkSystemPrompt(typed) }, ...history]);
  const reply = String(out.reply || '').trim() || 'Sorry, could you say that again?';
  history.push({ role: 'assistant', content: reply });
  const mistakes = isOpenTalk() ? [] : renderFix(log, out);
  if (mistakes.length && out.corrected && practiceLoop()) {
    // hold the reply; first practice the corrected sentence until you tap OK, continue
    setTalkDrill(String(out.corrected).trim(), reply, prevAi ? lastQuestion(prevAi.content) : '', mine);
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
let talkDrill = null; // { sentence, question, tries, reminders, el (your wrong bubble), reply? (turn by turn: the reply held back) }
const practiceLoop = () => !isOpenTalk() && corrOn() && S.sayCorrections;
/* The last question in a partner turn, so it can be asked again while you practice. */
function lastQuestion(text) {
  const qs = String(text || '').match(/[^.!?\n]*\?/g);
  return qs ? qs[qs.length - 1].replace(/^\s*(repeat after me\s*[:,]?\s*)?/i, '').trim() : '';
}
function setTalkDrill(sentence, reply, question, wrongEl) {
  const same = talkDrill && talkDrill.sentence === sentence;
  if (!same) {
    if (talkDrill && talkDrill.el) talkDrill.el.classList.remove('practice-pending');
    talkDrill = { sentence, question: '', tries: 0, reminders: 0, awaitingReply: false, checkFirst: false, reply: null, el: null };
  }
  if (reply) talkDrill.reply = reply;
  if (question && !talkDrill.question) talkDrill.question = question;
  if (wrongEl && !talkDrill.el) talkDrill.el = wrongEl;
  if (talkDrill.el) talkDrill.el.classList.add('practice-pending');
  $('drillText').textContent = sentence;
  $('drillQuestion').textContent = talkDrill.question ? 'Question: ' + talkDrill.question : '';
  $('drillQuestion').hidden = !talkDrill.question;
  $('drillBar').hidden = false;
}
/* done: you tapped OK, so the pending mistake turns green; otherwise (chat deleted, Open talk) it is just dropped */
function clearTalkDrill(done) {
  if (talkDrill && talkDrill.el) { talkDrill.el.classList.remove('practice-pending'); if (done) talkDrill.el.classList.add('practice-done'); }
  talkDrill = null; $('drillBar').hidden = true;
  persistChat();
}
/* After "OK, continue" the sentence is finished: replies, reminders and checks that were
   already on their way must not pin it (or anything else) again. */
let drillDoneAt = -1; // userTurnNo when you last tapped OK, continue
const drillDone = new Set();
const drillKey = (s) => words(s).join(' ');
const drillAllowed = (sentence, turnNo) => turnNo > drillDoneAt && !drillDone.has(drillKey(sentence));

/* Live calls: the app, not the model, decides when a sentence is being practiced and when it ends.
   Only "OK, continue" ends it. userTurnNo counts your finished utterances. */
let userTurnNo = 0;
let lastAiTurn = { text: '', userTurn: -1 };
let aiQuestions = []; // [{ userTurn, q }]: the partner's questions and how many of your turns came before each
let myBubbles = {};   // userTurnNo -> your bubble, to mark the wrong one
function questionBefore(turnNo) {
  for (let i = aiQuestions.length - 1; i >= 0; i--) if (aiQuestions[i].userTurn < turnNo && aiQuestions[i].q) return aiQuestions[i].q;
  return '';
}
function mentions(text, sentence, need = 0.6) {
  const want = words(sentence); if (!want.length) return true;
  const have = new Set(words(text));
  return want.filter((w) => have.has(w)).length / want.length >= need;
}
/* The partner did its job only if it gave the sentence again and asked its question again. */
function partnerStayed(text, d) { return mentions(text, d.sentence) && (!d.question || mentions(text, d.question, 0.5)); }
/* Interrupt the partner and send it a note, in either live engine. */
function liveInterrupt(note) {
  if (gl) { cutPlayback(gl); geminiSay(note); return true; }
  if (rt && rt.dc && rt.dc.readyState === 'open') {
    try { rt.dc.send(JSON.stringify({ type: 'response.cancel' })); rt.dc.send(JSON.stringify({ type: 'output_audio_buffer.clear' })); } catch { /* ignore */ }
    rtSay(note); return true;
  }
  return false;
}
function drillNote(d, first) {
  const ask = d.question ? ` Then ask me your question again: "${d.question}"` : '';
  return first
    ? `Wait, correct me first. I should say: "${d.sentence}". Say that sentence slowly, ask me to repeat it.${ask} The mistake stays open until I tap continue.`
    : `My mistake is still open, so do not move on and do not ask anything new. Briefly correct my last try if needed, say "${d.sentence}" again and ask me to repeat it.${ask}`;
}
function remindDrill(first) {
  const d = talkDrill; if (!d) return;
  if (d.remindedTurn === userTurnNo && d.reminders) return; // at most one reminder per thing you say
  d.remindedTurn = userTurnNo; d.reminders++;
  liveInterrupt(drillNote(d, first));
}
/* The checker found a mistake in what you just said: pin it until you tap OK, continue. */
function onLiveMistake(sentence, turnNo) {
  if (!practiceLoop() || !(rt || gl) || !sentence) return;
  if (!drillAllowed(sentence, turnNo)) return; // a check that finished after you tapped OK, continue
  if (talkDrill) return; // a mistake is already open; it stays the one being practiced
  setTalkDrill(sentence, null, questionBefore(turnNo), myBubbles[turnNo]);
  if (lastAiTurn.userTurn === turnNo) { if (!partnerStayed(lastAiTurn.text, talkDrill)) remindDrill(true); }
  else talkDrill.checkFirst = true; // judge the partner's reply when it finishes
}
/* A live partner turn finished. */
function liveTalkTurnDone(text) {
  lastAiTurn = { text, userTurn: userTurnNo };
  const q = lastQuestion(text);
  if (q) { aiQuestions.push({ userTurn: userTurnNo, q }); aiQuestions = aiQuestions.slice(-20); }
  if (!practiceLoop()) return;
  if (!talkDrill) {
    // the partner corrected you by itself: that opens the mistake too
    const d = parseDrill(text);
    if (d && drillAllowed(d.sentence, userTurnNo)) setTalkDrill(d.sentence, null, questionBefore(userTurnNo), myBubbles[userTurnNo]);
    return;
  }
  // while a mistake is open the model cannot swap it for another sentence; only OK, continue closes it
  if (talkDrill.checkFirst) { talkDrill.checkFirst = false; if (!partnerStayed(text, talkDrill)) remindDrill(true); return; }
  if (talkDrill.awaitingReply) { talkDrill.awaitingReply = false; if (!partnerStayed(text, talkDrill)) remindDrill(false); }
}
/* What you said while a mistake is open is checked against the sentence instead of being corrected again. */
function liveTalkUserSaid(text, bubbleEl) {
  if (!text) return false;
  userTurnNo++;
  docHeard(text);
  if (bubbleEl) { myBubbles[userTurnNo] = bubbleEl; delete myBubbles[userTurnNo - 30]; }
  if (!talkDrill) return false;
  talkDrill.tries++; talkDrill.awaitingReply = true;
  if (bubbleEl) bubbleEl.classList.add('practice-try');
  attemptCard($('log'), talkDrill.sentence, text, talkDrill.tries);
  return true;
}
function sayDrillAgain() {
  const d = talkDrill; if (!d) return;
  if (rt || gl) { liveInterrupt(`Please say "${d.sentence}" again, slowly and clearly, and let me repeat it.` + (d.question ? ` Then ask me again: "${d.question}"` : '')); return; }
  stopSpeaking(); speak(d.sentence + (d.question ? ' ' + d.question : ''), Number(S.rate) * 0.9).then(() => continueHandsFree());
}
async function continueFromDrill() {
  const d = talkDrill; clearTalkDrill(true);
  drillDoneAt = userTurnNo; if (d) drillDone.add(drillKey(d.sentence));
  const msg = "OK, my mistake is closed. Let's continue the conversation. Do not go back to that sentence.";
  if (rt || gl) { liveInterrupt(msg); return; }
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
        prompt('repeatSentence', { topic: topicLine('drill') }), settingsRule('repeat'),
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
  const base = prompt('liveConversation', openTalkVars()) + '\n' + settingsRule('live') + docBlock();
  if (!practiceLoop()) return base;
  return base + ' When you correct a mistake, say the corrected sentence and end with exactly: "Repeat after me: <the corrected sentence>", then ask your last question again. From then on the mistake is open: after everything the learner says, briefly correct it if needed, say the same corrected sentence again, ask them to repeat it, and ask your last question again. While a mistake is open do not ask anything new, do not change the topic and do not start practicing another sentence. Only when the learner says "OK, my mistake is closed" do you continue the conversation normally.';
}
/* Practice settings changed during a live call: apply them to the call now. */
function liveSettingsChanged(note) {
  if (rt && rt.dc && rt.dc.readyState === 'open') {
    rt.dc.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: rt.kind === 'repeat' ? repeatInstructions() : rtInstructions(), audio: { input: { transcription: rtTranscription() }, output: { speed: Math.max(0.25, Math.min(1.5, Number(S.rate) || 1)) } } } }));
    rtSay(withPace(note || "Let's continue."));
    setStatus('New settings applied to this call.');
  } else if (gl) {
    geminiApplySettings(note);
    setStatus('Switching the call to the new settings...');
  }
}
function rtTranscription() {
  return anyLanguage() ? { model: 'gpt-4o-mini-transcribe', prompt: transcriptionPrompt() } : { model: 'gpt-4o-mini-transcribe', language: 'en' };
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
        input: { transcription: rtTranscription(), turn_detection: { type: 'semantic_vad' }, noise_reduction: { type: 'near_field' } },
        output: { voice: S.rtVoice, speed: Math.max(0.25, Math.min(1.5, Number(S.rate) || 1)) },
      },
    };
    let sres = await fetch(API + '/realtime/client_secrets', { method: 'POST', headers: authJSON(), body: JSON.stringify({ session: sessionCfg }) });
    if (sres.status === 400) { // older sessions may not know noise_reduction: try again without it
      delete sessionCfg.audio.input.noise_reduction;
      sres = await fetch(API + '/realtime/client_secrets', { method: 'POST', headers: authJSON(), body: JSON.stringify({ session: sessionCfg }) });
    }
    if (!sres.ok) throw await apiError(sres);
    const sj = await sres.json();
    const ek = sj.value || sj.client_secret?.value;
    if (!ek) throw new Error('OpenAI did not return a session key.');
    if (rt !== state) return; // ended while connecting

    const pc = new RTCPeerConnection(); state.pc = pc;
    const audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', ''); state.audio = audio;
    document.body.appendChild(audio); audio.style.display = 'none'; applyVolume();
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
      if (kind === 'repeat') { setStatus('Live drill. Listen, then repeat. Tap the circle to stop.'); rtSay(withPace("Hi! Let's start.")); }
      else { setStatus('You are live. Just talk. Tap the circle to hang up.'); rtSay(withPace('Hi!')); }
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
  if (st.stream) releaseMic(true);
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
    if (isNoise(text)) { if (b) b.remove(); return; } // only background noise was heard
    if (isEcho(text, [lastAiTurn.text])) { if (b) b.remove(); return; } // the partner's own voice from the speaker
    const u = ev.usage;
    if (u && u.type === 'duration' && u.seconds) addCost('rt', (u.seconds / 60) * 0.003);
    else if (u && u.input_tokens) addCost('rt', ((u.input_tokens || 0) * 1.25 + (u.output_tokens || 0) * 5) / 1e6);
    if (text && !liveTalkUserSaid(text, b) && (S.rtWritten || practiceLoop()) && corrOn()) writtenCorrections(text, b);
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
  const turnNo = userTurnNo;
  try {
    const out = await chatJSON([
      { role: 'system', content: [
        prompt('checker'), settingsRule('checker'),
        'Return only JSON: {"mistakes":[{"wrong":"...","right":"...","why":"short explanation"}],"corrected":"the message with only the reported mistakes fixed, everything else kept as said, or empty"}',
      ].join('\n') },
      { role: 'user', content: text },
    ], 300);
    const mistakes = Array.isArray(out.mistakes) ? out.mistakes.filter((m) => m && (m.wrong || m.right)) : [];
    if (!mistakes.length) return; // stay quiet in a live call when there is nothing to fix
    if (S.rtWritten) {
      const tmp = el('div'); renderFix(tmp, out);
      const card = tmp.firstChild;
      if (afterEl && afterEl.parentNode) afterEl.after(card); else $('log').appendChild(card);
      persistChat();
    }
    if (out.corrected) onLiveMistake(String(out.corrected).trim(), turnNo);
  } catch { /* written corrections are optional */ }
}
function sendTypedRealtime(text) {
  const st = rt; if (!st || !st.dc || st.dc.readyState !== 'open') return false;
  bubble($('log'), 'me', text, { typed: true });
  st.dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  st.dc.send(JSON.stringify({ type: 'response.create' }));
  if (!liveTalkUserSaid(text, $('log').lastElementChild) && (S.rtWritten || practiceLoop()) && corrOn()) writtenCorrections(text, $('log').lastElementChild);
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
    // mic on (live call, connecting, recording): fast motion with a red center, so on and off look clearly different
    const micOn = phase === 'call' || phase === 'connecting' || phase === 'rec';
    const lead = micOn ? '#ef233c' : phase === 'think' ? fix : ai;
    const c = w / 2, base = w * 0.345 * (1 + orb.lvl * 0.22);
    const speed = orb.reduced ? 0 : (micOn || phase === 'think' ? 2.4 : 0.7);
    ctx.clearRect(0, 0, w, w);
    // soft halo
    const halo = ctx.createRadialGradient(c, c, base * 0.6, c, c, w / 2);
    halo.addColorStop(0, hexA(lead.startsWith('#') ? lead : '#b7a2ff', 0.28 + orb.lvl * 0.3));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(c, c, w / 2, 0, Math.PI * 2); ctx.fill();
    // three drifting layers
    const layers = micOn ? [['#c1121f', 0, 1.0], ['#ff4d6d', 2.1, 0.9], ['#ef233c', 4.2, 0.78]] : [[ai, 0, 1.0], [you, 2.1, 0.9], [lead, 4.2, 0.78]];
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
function syncHandsFree() { S.handsFree = false; } // the hands-free option was removed
/* The partner's volume inside the app (0 = silent). On iPhone the side buttons cannot go fully silent
   while the microphone is in use, so this is the way to turn it all the way down. */
const volGain = () => { const v = Math.max(0, Math.min(100, Number(S.volume))) / 100; return v * v; }; // feels even across the range
function applyVolume() {
  const g = volGain();
  if (gl && gl.out) { try { gl.out.gain.value = g; } catch { /* ignore */ } }
  [audioEl, rt && rt.audio, gl && gl.outEl].forEach((a) => { if (a) { try { a.volume = Math.min(1, g); a.muted = g === 0; } catch { /* ignore */ } } });
  if (gl && gl.outEl) { gl.outEl.muted = false; gl.outEl.volume = 1; } // Gemini is already turned down by its gain
  const muted = g === 0; // SVG parts ignore the hidden property on iPhone, so display is set directly
  $('volX').style.display = muted ? '' : 'none'; $('volWaves').style.display = muted ? 'none' : '';
  $('volX').removeAttribute('hidden');
  $('volVal').textContent = Math.round(S.volume) + '%';
}

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
  ['level', 'explainLang', 'accent', 'tone', 'voiceEngine', 'chatModel', 'sttModel', 'rtModel', 'openaiVoice', 'rtVoice', 'gLiveModel', 'gVoice'].forEach((id) => {
    const n = $(id); if (n.tagName === 'SELECT' && !n.options.length) return;
    n.value = S[id];
    n.addEventListener('change', () => {
      S[id] = n.value;
      const g = S.provider === 'gemini';
      if (id === 'chatModel') S[g ? 'gChat' : 'oaChat'] = n.value;
      if (id === 'sttModel') S[g ? 'gStt' : 'oaStt'] = n.value;
      saveSettings(); syncVoiceUI(); renderPrices();
      if (['level', 'explainLang', 'accent', 'tone'].includes(id)) liveSettingsChanged();
    });
  });
  ['sayCorrections', 'autoStop', 'speakTyped', 'rtWritten', 'keepMic', 'saveData', 'aiNoise'].forEach((id) => {
    const n = $(id); n.checked = !!S[id];
    n.addEventListener('change', () => { S[id] = n.checked; saveSettings(); syncHandsFree(); if (id === 'sayCorrections') liveSettingsChanged(); if (id === 'keepMic' && !n.checked && !rec && !rt && !gl) releaseMic(true); });
  });
  document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', () => {
    if (r.checked) { endAnyCall(); S.engine = r.value; S[S.provider === 'gemini' ? 'gEngine' : 'oaEngine'] = r.value; saveSettings(); syncEngineUI(); idleStatus(); }
  }));
  $('deviceVoice').addEventListener('change', () => { S.deviceVoice = $('deviceVoice').value; saveSettings(); });
  const showSpeed = () => { $('rateVal').textContent = `${S.speed}: ${SPEED_NAMES[S.speed]}`; };
  $('rate').value = S.speed; showSpeed();
  $('rate').addEventListener('input', () => { S.speed = Number($('rate').value); S.rate = SPEED_RATES[S.speed]; showSpeed(); saveSettings(); });
  $('rate').addEventListener('change', () => liveSettingsChanged());
  const showStrict = () => { $('strictVal').textContent = `${S.strict}: ${STRICT_NAMES[S.strict]}`; };
  $('strict').value = S.strict; showStrict();
  $('strict').addEventListener('input', () => { S.strict = Number($('strict').value); showStrict(); saveSettings(); });
  $('strict').addEventListener('change', () => liveSettingsChanged());
  const showLen = () => { $('replyLenVal').textContent = `${S.replyLen}: ${LEN_NAMES[S.replyLen]}`; };
  $('replyLen').value = S.replyLen; showLen();
  $('replyLen').addEventListener('input', () => { S.replyLen = Number($('replyLen').value); showLen(); saveSettings(); });
  $('replyLen').addEventListener('change', () => liveSettingsChanged());
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
  $('docBtn').hidden = m !== 'talk'; renderDocBar();
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
/* iPhone: add the app to the Home Screen, and let Safari always allow the microphone. */
GUIDES.install = {
  title: 'Add EN Speaking to your Home Screen',
  intro: 'It then opens full screen like a real app, with its own icon. Takes ten seconds.',
  steps: [
    ['Tap the <b>three dots</b> next to the address bar at the bottom.', 'guide/install-1.jpg', 'Safari address bar with the three dots button marked'],
    ['Tap <b>Share</b>.', 'guide/install-2.jpg', 'Safari menu with Share marked'],
    ['Tap <b>View More</b> (the arrow pointing down).', 'guide/install-3.jpg', 'Share sheet with View More marked'],
    ['Tap <b>Add to Home Screen</b>, then <b>Add</b> at the top right.', 'guide/install-4.jpg', 'Share options with Add to Home Screen marked'],
    ['Open EN Speaking from its new icon on your Home Screen.'],
  ],
  note: '',
  done: 'Got it', dismiss: "Don't show this again",
};
GUIDES.mic = {
  title: 'Microphone always on',
  intro: 'Let Safari use the microphone without asking each time. This is a setting of your iPhone, not of the app.',
  steps: [
    ['Open the iPhone <b>Settings</b> app.'],
    ['Tap <b>Apps</b>, then <b>Safari</b>.'],
    ['Scroll down to <b>Settings for Websites</b> and tap <b>Microphone</b>.', 'guide/mic-1.jpg', 'Safari settings with Microphone marked'],
    ['Choose <b>Allow</b>.', 'guide/mic-2.jpg', 'Microphone Access On All Websites with Allow marked'],
    ['Come back to EN Speaking.'],
  ],
  note: 'If the app on your Home Screen still asks once after you open it, tap Allow. Apple decides this part; the app cannot change it.',
  done: 'Done',
};
function openGuide(kind) {
  const g = GUIDES[kind];
  $('guideTitle').textContent = g.title;
  const notSafari = kind === 'install' && !IS_IOS_SAFARI
    ? '<p class="hint bad">These steps are for Safari. Open this page in Safari first.</p>' : '';
  $('guideBody').innerHTML =
    `<p class="guide-intro">${g.intro}</p>` + notSafari +
    (g.url ? `<a class="guide-link" href="${g.url}" target="_blank" rel="noopener noreferrer"><span>${g.open}</span><small>${g.site}</small></a>` : '') +
    '<ol class="guide-steps">' + g.steps.map(([t, img, alt]) =>
      `<li><p>${t}</p>${img ? `<div class="shot"><img src="${img}?v=2" alt="${esc(alt)}" loading="lazy"><span class="shot-hint">Tap to enlarge</span></div>` : ''}</li>`).join('') + '</ol>' +
    (g.note ? `<p class="hint">${g.note}</p>` : '') +
    `<button type="button" class="pill-btn strong guide-done" data-field="${g.field || ''}">${g.done || 'I have my key'}</button>` +
    (g.dismiss ? `<button type="button" class="pill-btn guide-dismiss">${g.dismiss}</button>` : '');
  const dis = $('guideBody').querySelector('.guide-dismiss');
  if (dis) dis.onclick = () => { store.set('ens.noInstallHint', true); $('guide').close(); };
  // tap a picture to see it full size (pinch zoom is off in this app)
  $('guideBody').querySelectorAll('.guide-steps img').forEach((im) => {
    im.addEventListener('click', () => { const z = im.closest('.shot'); z.classList.toggle('zoom'); });
  });
  $('guideBody').querySelector('.guide-done').onclick = (e) => { $('guide').close(); const f = e.target.dataset.field && $(e.target.dataset.field); if (f) f.focus(); };
  $('guideBody').scrollTop = 0;
  try { $('guide').showModal(); } catch { $('guide').setAttribute('open', ''); }
}
function setupGuide() {
  $('micAlwaysBtn').addEventListener('click', () => openGuide('mic'));
  $('micGroup').hidden = !IS_IOS;
  // iPhone in the browser (not opened from the Home Screen): offer to add it, until "Don't show this again"
  if (IS_IOS && !IS_STANDALONE && !store.get('ens.noInstallHint', false)) setTimeout(() => { if (!$('settings').open) openGuide('install'); }, 900);
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
  $('volume').value = S.volume; applyVolume();
  $('volBtn').addEventListener('click', (e) => { e.stopPropagation(); const open = $('volPop').hidden; $('volPop').hidden = !open; $('volBtn').setAttribute('aria-expanded', open ? 'true' : 'false'); });
  $('volPop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!$('volPop').hidden) { $('volPop').hidden = true; $('volBtn').setAttribute('aria-expanded', 'false'); } });
  $('volume').addEventListener('input', () => { S.volume = Number($('volume').value); applyVolume(); saveSettings(); });
  document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  $('drillContinue').addEventListener('click', () => { unlockAudio(); stopSpeaking(); continueFromDrill(); });
  $('drillRepeat').addEventListener('click', () => { unlockAudio(); sayDrillAgain(); });
  document.querySelectorAll('#talkModes .tm').forEach((b) => b.addEventListener('click', () => {
    if (S.talkMode === b.dataset.tm) return;
    S.talkMode = b.dataset.tm; saveSettings(); syncTalkMode();
    if (isOpenTalk() && talkDrill) { if (rt || gl) clearTalkDrill(); else continueFromDrill(); }
    // in a live call: switch the call itself and have the partner say so
    liveSettingsChanged(isOpenTalk()
      ? 'From now on this is OPEN TALK: no corrections, and I may also speak Persian. Say briefly that we are in open talk now, then continue our conversation.'
      : 'From now on this is PRACTICE: correct my mistakes as instructed. Say briefly that we are in practice mode now, then continue our conversation.');
    if (!rt && !gl) setStatus(isOpenTalk() ? 'Open talk: no corrections. Talk or ask anything.' : 'Practice: your mistakes will be corrected.');
  }));
  syncTalkMode();
  setupDoc();
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
    history = []; $('log').innerHTML = ''; store.del('ens.chat'); clearTalkDrill(); drillDone.clear(); aiQuestions = []; myBubbles = {}; clearDoc(); emptyState();
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
