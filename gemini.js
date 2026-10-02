/* EN Speaking: Google Gemini support.
   - Text and transcription through generateContent (turn-by-turn engine).
   - Gemini Live: a voice call over a WebSocket, mic sent as 16 kHz PCM, replies played as 24 kHz PCM.
   Uses globals from app.js (S, gKey, $, el, bubble, levels, setPhase, setStatus, addCost, ...).
   Loaded before app.js; its functions only run after app.js has started. */
'use strict';

const GAPI = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/* Paid prices per 1M tokens (Gemini Developer API, Oct 2026). On the free tier everything is $0. */
const GEMINI_TEXT = {
  'gemini-3.5-flash-lite': { in: 0.30, ain: 0.30, out: 2.50, note: 'fast' },
  'gemini-3.1-flash-lite': { in: 0.25, ain: 0.50, out: 1.50, note: 'fast' },
  'gemini-3.8-flash': { in: 0.75, ain: 0.75, out: 3.75, note: 'smarter' },
  'gemini-3-flash-preview': { in: 0.50, ain: 1.00, out: 3.00, note: '' },
};
/* Live models: paid audio is $0.005 per minute in and $0.018 per minute out. */
const GEMINI_LIVE = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-3.8-live-extended-thinking'];
const GEMINI_LIVE_PRICE = { inMin: 0.005, outMin: 0.018 };
const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];

const isGem = (m) => /^gemini/.test(String(m || ''));

function gPrice(model) {
  const o = S.prices[model] || {};
  const base = GEMINI_TEXT[model] || (/lite/.test(model) ? GEMINI_TEXT['gemini-3.5-flash-lite'] : GEMINI_TEXT['gemini-3.8-flash']);
  return Object.assign({}, base, o);
}
function gLivePrice() { return Object.assign({}, GEMINI_LIVE_PRICE, S.prices[S.gLiveModel] || {}); }

async function gError(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch { /* ignore */ }
  if (/api key not valid|API_KEY_INVALID/i.test(msg) || res.status === 401 || res.status === 403) return new Error('Google rejected the Gemini key. Check it in Settings. (' + msg + ')');
  if (res.status === 429) return new Error('Gemini free limit reached for now. Try again later, or switch to an OpenAI model. (' + msg + ')');
  if (res.status === 404) return new Error(msg + ' Pick another Gemini model in Settings.');
  const e = new Error(msg); e.status = res.status; return e;
}

async function fetchGeminiModels() {
  const res = await fetch(`${GAPI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': gKey } });
  if (!res.ok) throw await gError(res);
  const j = await res.json();
  availableGemini = (j.models || []).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), methods: m.supportedGenerationMethods || [] }));
  store.set('ens.gmodels', availableGemini);
  return availableGemini;
}
function geminiLists() {
  const av = availableGemini || [];
  const ids = av.map((m) => m.id);
  const textOk = (id) => /^gemini-[\d.]+-flash(-lite)?(-preview)?$/.test(id);
  const text = Array.from(new Set([...Object.keys(GEMINI_TEXT).filter((m) => !availableGemini || ids.includes(m)), ...ids.filter(textOk)]));
  const live = Array.from(new Set([...GEMINI_LIVE.filter((m) => !availableGemini || ids.includes(m)),
    ...av.filter((m) => /live|native-audio/.test(m.id) && !/translate|transcribe/.test(m.id)).map((m) => m.id)]));
  return { text: text.length ? text : Object.keys(GEMINI_TEXT), live: live.length ? live : GEMINI_LIVE.slice() };
}
function gemLabel(m) {
  const p = gPrice(m); const n = (GEMINI_TEXT[m] || {}).note;
  return `${m}  (${S.gemFree ? 'free tier' : `$${p.in} / $${p.out}`})${n ? ', ' + n : ''}`;
}

/* ---------- generateContent ---------- */
const gVariantOk = {}; // per model: index of the request variant the API accepted
function gVariants(model, json) {
  const think = /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: /lite/.test(model) ? 'minimal' : 'low' };
  const v = [];
  if (json) { v.push({ responseMimeType: 'application/json', thinkingConfig: think }); v.push({ responseMimeType: 'application/json' }); }
  v.push({ thinkingConfig: think }); v.push({});
  return v;
}
async function geminiGenerate(model, system, contents, maxTokens, json, kind) {
  const variants = gVariants(model, json);
  const order = gVariantOk[model] !== undefined ? [gVariantOk[model]] : variants.map((_, i) => i);
  let lastErr;
  for (const i of order) {
    const gc = Object.assign({ maxOutputTokens: maxTokens + 1024 }, variants[i]);
    const body = { contents, generationConfig: gc };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await fetch(`${GAPI}/models/${model}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': gKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      lastErr = await gError(res);
      if (lastErr.status === 400) continue; // try a simpler request shape
      throw lastErr;
    }
    gVariantOk[model] = i;
    const j = await res.json();
    const u = j.usageMetadata || {};
    if (!S.gemFree) {
      const p = gPrice(model);
      const inRate = kind === 'stt' ? p.ain : p.in;
      addCost('gem', ((u.promptTokenCount || 0) * inRate + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * p.out) / 1e6, { gemTok: u.totalTokenCount || 0 });
    } else {
      addCost('gem', 0, { gemTok: u.totalTokenCount || 0 });
    }
    const parts = j.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    if (!text && j.candidates?.[0]?.finishReason && j.candidates[0].finishReason !== 'STOP') {
      throw new Error('Gemini stopped early (' + j.candidates[0].finishReason + '). Try again.');
    }
    return text;
  }
  throw lastErr || new Error('Gemini did not answer.');
}
function parseLooseJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
async function geminiJSON(messages, maxTokens) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const text = await geminiGenerate(S.chatModel, system, contents, maxTokens, true, 'chat');
  try { return parseLooseJSON(text); } catch { throw new Error('Gemini sent an answer I could not read. Try again.'); }
}

/* Recorded audio -> 16 kHz mono WAV, which every Gemini model accepts. */
async function toWav16k(blob) {
  const ctx = getCtx(); if (!ctx) throw new Error('This browser cannot process audio.');
  const ab = await blob.arrayBuffer();
  const audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
  const src = audio.getChannelData(0);
  const ratio = audio.sampleRate / 16000;
  const n = Math.floor(src.length / ratio);
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(src.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let k = a; k < b; k++) s += src[k]; s = b > a ? s / (b - a) : src[a] || 0;
    out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}
function bytesToB64(bytes) {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

async function geminiTranscribe(blob) {
  const wav = await toWav16k(blob);
  const text = await geminiGenerate(S.sttModel,
    transcriptionPrompt(),
    [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: bytesToB64(wav) } },
      { text: 'Transcribe this audio word for word. Output only the transcript. If there is no speech, output nothing.' }] }],
    400, false, 'stt');
  return String(text || '').replace(/^["\s]+|["\s]+$/g, '').trim();
}

/* ---------- Gemini Live ---------- */
let gl = null;
let workletReady = false;
const PCM_TAP = 'class T extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("pcm-tap",T);';

function repeatInstructions() {
  return [
    prompt('liveRepeat', { topic: topicLine('drill'), opening: openingLine('drill') }),
    settingsRule('repeat'),
    'Whenever you give the learner something to repeat, a whole sentence or a single word, end that turn with exactly this pattern and nothing after it: "Repeat after me: <the sentence or word>". Then stop and wait. Do not use this pattern in any other turn.',
    'Never move on to a new sentence by yourself. Stay on the current sentence until the learner says "Next sentence, please".',
  ].join(' ');
}
/* Ask the coach for something during a live call, as if the learner had typed it. */
function geminiSay(text) {
  const st = gl; if (!st || !st.ws || st.ws.readyState !== 1 || !st.setupDone) return false;
  st.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
  return true;
}
/* Pull the drill sentence out of the coach's words: whatever follows the last "Repeat after me". */
function parseDrill(text) {
  const t = String(text || '');
  const i = t.toLowerCase().lastIndexOf('repeat after me');
  if (i < 0) return null;
  const sentence = t.slice(i + 15).replace(/^\s*[:,.\-]?\s*/, '').replace(/^["“]|["”]\s*$/g, '').trim();
  return sentence ? { sentence, before: t.slice(0, i).trim() } : null;
}

async function startGeminiCall(kind = 'talk', opts = {}) {
  if (!gKey) { setStatus('Add your Gemini key in Settings first.', true); openSettings(); return; }
  setPhase('connecting'); setStatus('Connecting to Gemini...');
  setAudioSession('play-and-record');
  // Gemini's voice is played through an <audio> element (media channel, volume buttons work).
  // It is created and started here, still inside the tap, because iPhone blocks play() later.
  const outCtx = getCtx();
  let outEl = null, outDest = null;
  try {
    outDest = outCtx.createMediaStreamDestination();
    outEl = document.createElement('audio'); outEl.setAttribute('playsinline', ''); outEl.autoplay = true;
    outEl.srcObject = outDest.stream; outEl.style.display = 'none'; document.body.appendChild(outEl);
    outEl.play().catch(() => {});
  } catch { outEl = null; outDest = null; }
  const st = { kind, carry: opts.carry && kind === 'talk' ? recentConversation() : '', note: opts.note || '', outEl, outDest, ws: null, stream: null, ctx: null, q: [], sentSec: 0, outSec: 0, billedIn: 0, billedOut: 0, playT: 0, sources: [],
    t0: 0, timer: null, handle: null, basic: false, setupDone: false, closing: false, reconnects: 0, me: null, meText: '', ai: null, aiText: '', stops: [] };
  gl = st;
  try {
    st.stream = await getMic();
    const ctx = getCtx(); if (!ctx || !ctx.audioWorklet) throw new Error('This browser cannot stream audio for Gemini Live.');
    st.ctx = ctx;
    if (!workletReady) {
      const url = URL.createObjectURL(new Blob([PCM_TAP], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url); workletReady = true;
    }
    if (gl !== st) { releaseMic(); return; }
    const src = ctx.createMediaStreamSource(st.stream);
    const tap = new AudioWorkletNode(ctx, 'pcm-tap');
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
    tap.port.onmessage = (e) => onMicChunk(st, e.data);
    st.stops.push(() => { try { tap.port.onmessage = null; src.disconnect(); tap.disconnect(); mute.disconnect(); } catch { /* ignore */ } });
    // replies go through one gain node so they can be metered and cut on interruption
    st.out = ctx.createGain();
    if (st.outDest && st.outEl && !st.outEl.paused) st.out.connect(st.outDest); else st.out.connect(ctx.destination);
    const an = ctx.createAnalyser(); an.fftSize = 512; st.out.connect(an);
    const buf = new Float32Array(an.fftSize); let alive = true;
    const tick = () => { if (!alive) return; an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; levels.ai = Math.min(1, Math.sqrt(s / buf.length) * 9); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    st.stops.push(() => {
      alive = false; try { st.out.disconnect(); } catch { /* ignore */ }
      if (st.outEl) { try { st.outEl.pause(); st.outEl.srcObject = null; st.outEl.remove(); } catch { /* ignore */ } }
    });
    const m = meter(st.stream, (rms) => { levels.mic = Math.min(1, rms * 10); }); if (m) st.stops.push(m);
    openGeminiSocket(st);
  } catch (e) {
    endGemini(e.name === 'NotAllowedError' ? micHelp() : e.message, true);
  }
}
function geminiSetup(st) {
  const setup = {
    model: 'models/' + S.gLiveModel,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: S.gVoice } } } },
    systemInstruction: { parts: [{ text: (st.kind === 'repeat' ? repeatInstructions() : rtInstructions()) + st.carry }] },
    inputAudioTranscription: st.basic ? {} : { mode: 'VERBATIM' },
    outputAudioTranscription: {},
  };
  if (!st.basic) {
    setup.sessionResumption = st.handle ? { handle: st.handle } : {};
    // long talks: let Gemini drop the oldest audio instead of ending the session when its memory fills up
    setup.contextWindowCompression = { slidingWindow: {} };
    // start of speech a little less eager (background noise); end of speech left at Gemini's fast default
    setup.realtimeInputConfig = { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW' } };
  }
  else if (st.handle) setup.sessionResumption = { handle: st.handle };
  return { setup };
}
function openGeminiSocket(st) {
  const ws = new WebSocket(GEMINI_WS + '?key=' + encodeURIComponent(gKey));
  ws.binaryType = 'arraybuffer';
  st.ws = ws; st.setupDone = false;
  ws.onopen = () => ws.send(JSON.stringify(geminiSetup(st)));
  ws.onmessage = async (e) => {
    let txt;
    if (typeof e.data === 'string') txt = e.data;
    else if (e.data instanceof ArrayBuffer) txt = new TextDecoder().decode(e.data);
    else txt = await e.data.text();
    let msg; try { msg = JSON.parse(txt); } catch { return; }
    if (gl === st && st.ws === ws) onGeminiMsg(st, msg);
  };
  ws.onclose = (e) => {
    if (gl !== st || st.ws !== ws || st.closing) return;
    const why = e.reason ? ': ' + e.reason : ` (code ${e.code})`;
    if (!st.setupDone) {
      if (st.t0) { if (recoverGemini(st)) return; } // the call had been running: start a fresh session instead
      else if (!st.basic) { st.basic = true; openGeminiSocket(st); return; } // first connect: retry with the simplest setup
      endGemini(st.t0 ? 'Lost the connection to Gemini' + why + '. Tap the circle to start again; the chat is kept.'
        : 'Gemini refused the call' + why + '. Check the Gemini key and the Live model in Settings.', true);
      return;
    }
    if (st.handle && st.reconnects < 6) { st.reconnects++; setStatus('Reconnecting...'); openGeminiSocket(st); return; }
    if (e.code !== 1000 && recoverGemini(st)) return;
    endGemini(e.reason ? 'Gemini ended the call: ' + e.reason : 'The Gemini call ended.', !!e.reason && e.code !== 1000);
  };
}
/* A running call dropped and could not be resumed (Gemini often answers "Internal error" to an old
   resume handle). Start a brand-new session that gets the last few exchanges, up to 3 times in a row. */
function recoverGemini(st) {
  st.recovers = (st.recovers || 0) + 1;
  if (st.recovers > 3) return false;
  st.handle = null; st.basic = false; st.reconnects = 0;
  if (st.kind === 'talk') st.carry = recentConversation();
  st.started = false;
  st.note = st.kind === 'repeat' ? "We got disconnected for a moment. Let's continue the drill." : "We got disconnected for a moment. Let's continue where we were.";
  cutPlayback(st);
  setStatus('Connection dropped. Reconnecting...');
  setTimeout(() => { if (gl === st && !st.closing) openGeminiSocket(st); }, 500 * st.recovers);
  return true;
}
function onMicChunk(st, f32) {
  if (!st.setupDone || !st.ws || st.ws.readyState !== 1) return;
  const ratio = st.ctx.sampleRate / 16000;
  const n = Math.floor(f32.length / ratio);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(f32.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let k = a; k < b; k++) s += f32[k]; st.q.push(b > a ? s / (b - a) : f32[a] || 0);
  }
  if (st.q.length < 640) return; // send about every 40 ms
  // On the phone speaker the partner's own voice comes back into the mic and gets transcribed as yours.
  // So while the partner is talking (and a moment after), silence is sent instead of the mic,
  // unless "talk over the partner" is on (for headphones).
  const pcm = new DataView(new ArrayBuffer(st.q.length * 2));
  let sum = 0;
  for (let i = 0; i < st.q.length; i++) { const v = Math.max(-1, Math.min(1, st.q[i])); sum += v * v; pcm.setInt16(i * 2, v * 0x7fff, true); }
  const rms = Math.sqrt(sum / st.q.length);
  const chunk = bytesToB64(new Uint8Array(pcm.buffer));
  st.sentSec += st.q.length / 16000; st.q = [];
  const send = (data) => st.ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }));
  if (!echoGate(st, rms, chunk)) { send(SILENCE_40MS); return; }
  if (st.preroll && st.preroll.length) { st.preroll.forEach(send); st.preroll = []; }
  send(chunk);
}
/* Echo gate. On the phone speaker the partner's voice comes back into the mic, and the browser cannot
   cancel it (the voice arrives over a WebSocket, outside the browser's echo canceller). So while the
   partner talks, and 0.6 s after, the mic is replaced by silence, except when you speak clearly louder
   than the echo: then you can interrupt. The echo level is learned during each reply.
   "Talk over the partner" (headphones) turns the gate off. */
const SILENCE_40MS = bytesToB64(new Uint8Array(1280));
function echoGate(st, rms, chunk) {
  if (S.bargeIn) return true;
  const now = st.ctx.currentTime;
  // the iPhone plays the voice through an <audio> element, which adds delay: keep the gate longer there
  const talking = st.playT && now < st.playT + 0.5;
  if (!talking) { st.replyStart = 0; st.gateOpenUntil = 0; st.preroll = []; st.loud = 0; return true; }
  if (!st.replyStart) st.replyStart = now;
  if (now < st.gateOpenUntil) { st.gateOpenUntil = now + 1.2; return true; } // you are talking: keep it open
  // keep the last 0.2 s so the start of your words is not lost if the gate opens
  st.preroll = (st.preroll || []).concat(chunk).slice(-5);
  const floor = st.echoFloor || 0.02;
  const learning = now - st.replyStart < 0.4; // start of each reply: only learn the echo level
  // open only for clearly louder speech that lasts (0.16 s), not for a loud moment of the echo
  if (!learning && rms > Math.max(0.05, floor * 3.5)) { st.loud = (st.loud || 0) + 1; if (st.loud >= 3) { st.gateOpenUntil = now + 1.2; return true; } return false; }
  st.loud = 0;
  st.echoFloor = floor * 0.92 + rms * 0.08; // average echo level during this reply
  return false;
}
function playPcm24(st, b64) {
  const bytes = b64ToBytes(b64); const n = bytes.length >> 1; if (!n) return;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ab = st.ctx.createBuffer(1, n, 24000); const ch = ab.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  const src = st.ctx.createBufferSource(); src.buffer = ab; src.connect(st.out);
  st.playT = Math.max(st.playT, st.ctx.currentTime + 0.04);
  src.start(st.playT); st.playT += ab.duration; st.outSec += ab.duration;
  st.sources.push(src); src.onended = () => { st.sources = st.sources.filter((x) => x !== src); };
}
function cutPlayback(st) {
  st.sources.forEach((s) => { try { s.stop(); } catch { /* ignore */ } });
  st.sources = []; st.playT = 0;
}
function finishMyTurn(st) {
  if (st.kind === 'repeat') {
    const text = st.meText.trim(); st.meText = '';
    if (st.meStarted && text && target) renderAttempt(text);
    st.meStarted = false;
    return;
  }
  if (!st.me) return;
  const text = st.meText.trim(); const b = st.me;
  st.me = null; st.meText = '';
  b.classList.remove('pending');
  if (isNoise(text)) { b.remove(); return; } // only background noise was heard
  if (isEcho(text, [st.aiText, lastAiTurn.text, st.prevAi])) { b.remove(); return; } // the partner's own voice from the speaker
  history.push({ role: 'user', content: text }); history = history.slice(-16);
  if (!liveTalkUserSaid(text, b) && (S.rtWritten || practiceLoop()) && corrOn()) writtenCorrections(text, b);
  persistChat();
}
function onGeminiMsg(st, msg) {
  if (msg.setupComplete) {
    st.setupDone = true;
    if (st.recovers) setTimeout(() => { if (gl === st && st.setupDone) st.recovers = 0; }, 20000); // stayed up: allow new recoveries later
    if (!st.t0) {
      st.t0 = performance.now();
      st.timer = setInterval(() => {
        if (gl !== st) return;
        flushGeminiCost(st);
        $('status').textContent = `Live with Gemini for ${fmtDur((performance.now() - st.t0) / 1000)}. Tap the circle to hang up.`;
      }, 1000);
    }
    setPhase('call');
    if (st.kind === 'repeat') {
      setStatus('Live drill with Gemini. Listen, then repeat. Tap the circle to stop.');
      if (!st.started) { st.started = true; geminiSay(st.note || "Hi! Let's start."); }
    } else {
      setStatus('You are live with Gemini. Just talk. Tap the circle to hang up.');
      if (!st.started) { st.started = true; geminiSay(st.note || 'Hi!'); }
    }
    return;
  }
  if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.newHandle) st.handle = msg.sessionResumptionUpdate.newHandle;
  if (msg.goAway && st.handle) {
    // the server will close this connection soon; move to a fresh one and keep the conversation
    const old = st.ws; st.ws = null; try { old.close(); } catch { /* ignore */ }
    openGeminiSocket(st); return;
  }
  const sc = msg.serverContent;
  if (!sc) return;
  const log = st.kind === 'repeat' ? $('repeatLog') : $('log');
  if (sc.interrupted) cutPlayback(st);
  if (st.kind === 'repeat' && sc.inputTranscription && sc.inputTranscription.text) {
    st.meText += sc.inputTranscription.text; st.meStarted = true;
    $('status').textContent = 'Hearing: ' + st.meText.trim();
  } else if (sc.inputTranscription && sc.inputTranscription.text) {
    if (!st.me) { clearEmpty(log); st.me = bubble(log, 'me', '', { pending: true }); st.meText = ''; }
    st.meText += sc.inputTranscription.text;
    st.me.querySelector('.txt').textContent = st.meText.trim();
    scrollDown(log);
  }
  const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
  const hasAudio = parts.some((p) => p.inlineData && p.inlineData.data);
  if ((sc.outputTranscription && sc.outputTranscription.text) || hasAudio) finishMyTurn(st);
  parts.forEach((p) => { if (p.inlineData && p.inlineData.data) playPcm24(st, p.inlineData.data); });
  if (sc.outputTranscription && sc.outputTranscription.text) {
    if (!st.ai) { clearEmpty(log); st.ai = bubble(log, 'ai', ''); st.aiText = ''; }
    st.aiText += sc.outputTranscription.text;
    st.ai.querySelector('.txt').textContent = st.aiText.trim();
    scrollDown(log);
  }
  if (sc.turnComplete && st.kind === 'repeat') {
    const said = st.aiText.trim(); const d = parseDrill(said);
    if (d) {
      if (!target || target.sentence !== d.sentence) attempts = 0;
      target = { sentence: d.sentence, focus: '' };
      $('target').textContent = d.sentence; $('focus').textContent = '';
      $('hearAgain').disabled = false; $('hearSlow').disabled = false;
      if (st.ai) { if (d.before) st.ai.querySelector('.txt').textContent = d.before; else { st.ai.remove(); st.ai = null; } }
      setStatus('Now repeat the sentence.');
    }
    if (st.ai && !st.ai.querySelector('.txt').textContent.trim()) st.ai.remove();
    st.ai = null; st.aiText = '';
    return;
  }
  if (sc.turnComplete) {
    finishMyTurn(st);
    if (st.ai && st.aiText.trim()) { st.prevAi = lastAiTurn.text; history.push({ role: 'assistant', content: st.aiText.trim() }); history = history.slice(-16); liveTalkTurnDone(st.aiText.trim()); }
    st.ai = null; st.aiText = '';
    persistChat();
  }
}
function flushGeminiCost(st) {
  const dIn = st.sentSec - st.billedIn, dOut = st.outSec - st.billedOut;
  if (dIn <= 0 && dOut <= 0) return;
  st.billedIn = st.sentSec; st.billedOut = st.outSec;
  const p = gLivePrice();
  addCost('gem', S.gemFree ? 0 : (dIn / 60) * p.inMin + (dOut / 60) * p.outMin, { gemSec: dIn });
}
function endGemini(msg, isErr = false) {
  const st = gl; if (!st) return;
  gl = null; st.closing = true;
  clearInterval(st.timer);
  flushGeminiCost(st);
  try { st.ws && st.ws.close(); } catch { /* ignore */ }
  cutPlayback(st);
  st.stops.forEach((f) => f());
  if (st.stream) releaseMic();
  if (st.outEl) { try { st.outEl.pause(); st.outEl.srcObject = null; st.outEl.remove(); } catch { /* ignore */ } }
  if (st.me || st.meStarted) finishMyTurn(st);
  setAudioSession('playback');
  levels.mic = levels.ai = 0;
  setPhase('idle'); renderSpend();
  setStatus(msg || `Call ended. This session so far: ${money(sessionTotal())}.`, isErr);
}
/* Reconnect the call with the current settings, keeping the conversation through the resumption handle. */
/* New settings during a call: a resumed session keeps following its old instructions, so the call is
   restarted as a fresh session that gets the new instructions plus the last few exchanges. */
function geminiApplySettings(note) {
  const st = gl; if (!st) return false;
  const kind = st.kind;
  endGemini(' ');
  startGeminiCall(kind, { carry: true, note: note || (kind === 'repeat' ? "Let's continue the drill with the new settings." : "Let's continue our conversation.") });
  return true;
}
function recentConversation() {
  const turns = history.slice(-10);
  if (!turns.length) return '';
  return '\n\nEarlier in this same conversation (continue it naturally from here; do not greet again and do not ask for the topic again):\n' +
    turns.map((t) => (t.role === 'user' ? 'Learner: ' : 'You: ') + String(t.content).slice(0, 400)).join('\n');
}
function sendTypedGemini(text) {
  const st = gl; if (!st || !st.ws || st.ws.readyState !== 1 || !st.setupDone) return false;
  const b = bubble($('log'), 'me', text, { typed: true });
  history.push({ role: 'user', content: text }); history = history.slice(-16);
  st.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
  if (!liveTalkUserSaid(text, b) && (S.rtWritten || practiceLoop()) && corrOn()) writtenCorrections(text, b);
  return true;
}
