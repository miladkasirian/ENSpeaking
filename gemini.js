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

/* RNNoise (xiph.org, MIT license, via @sapphi-red/web-noise-suppressor): a small neural network that
   removes background noise and keeps speech. It works at 48 kHz; on other rates the plain filter is used. */
let rnnoiseBin = null; let rnnoiseCtx = null;
async function rnnoiseNode(ctx) {
  if (!S.aiNoise || ctx.sampleRate !== 48000) return null;
  try {
    if (rnnoiseCtx !== ctx) {
      const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
      if (!rnnoiseBin) rnnoiseBin = await (await fetch(simd ? 'vendor/rnnoise_simd.wasm' : 'vendor/rnnoise.wasm')).arrayBuffer();
      await ctx.audioWorklet.addModule('vendor/rnnoise-worklet.js');
      rnnoiseCtx = ctx;
    }
    return new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { maxChannels: 1, wasmBinary: rnnoiseBin },
    });
  } catch { return null; }
}
/* Echo cancellation needs to know what the speaker is playing. The browser's echo canceller only "sees"
   sound that comes from a WebRTC call, so the partner's voice is passed through a local WebRTC connection
   (inside the phone, nothing goes out) before it is played. If anything fails, it plays directly as before. */
async function echoLoopback(st) {
  if (!window.RTCPeerConnection || !st.outDest || !st.outEl) return;
  try {
    const a = new RTCPeerConnection(); const b = new RTCPeerConnection();
    a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
    b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
    b.ontrack = (e) => {
      const el = st.outEl; if (!el || gl !== st) return;
      const direct = el.srcObject;
      el.srcObject = e.streams[0] || new MediaStream([e.track]);
      el.play().then(() => { st.loopback = true; }).catch(() => { el.srcObject = direct; el.play().catch(() => {}); });
    };
    st.outDest.stream.getAudioTracks().forEach((t) => a.addTrack(t, st.outDest.stream));
    await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
    st.stops.push(() => { try { a.close(); b.close(); } catch { /* ignore */ } });
  } catch { /* plays directly */ }
}
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
    if (gl !== st) { releaseMic(true); return; }
    const src = ctx.createMediaStreamSource(st.stream);
    const tap = new AudioWorkletNode(ctx, 'pcm-tap');
    const mute = ctx.createGain(); mute.gain.value = 0;
    // raw microphone (only the phone's own echo cancellation, noise suppression and gain), nothing in between
    src.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
    tap.port.onmessage = (e) => onMicChunk(st, e.data);
    st.stops.push(() => { try { tap.port.onmessage = null; src.disconnect(); tap.disconnect(); mute.disconnect(); } catch { /* ignore */ } });
    // replies go through one gain node so they can be metered and cut on interruption
    st.out = ctx.createGain(); st.out.gain.value = volGain();
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
    // Gemini Live itself writes down what you say; it is told to use only English (or English and Persian)
    inputAudioTranscription: st.basic ? {} : st.noLang ? { mode: 'VERBATIM' } : { mode: 'VERBATIM', languageCodes: ['en-US'] },
    outputAudioTranscription: {},
  };
  if (!st.basic) {
    setup.sessionResumption = st.handle ? { handle: st.handle } : {};
    // long talks: let Gemini drop the oldest audio instead of ending the session when its memory fills up
    setup.contextWindowCompression = { slidingWindow: {} };
    // Gemini's speech detection at its most sensitive: soft voices and short sounds like "uh-huh" count,
    // and your turn ends quickly after you stop (less delay)
    setup.realtimeInputConfig = { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', prefixPaddingMs: 20, silenceDurationMs: 500 } };
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
      else if (!st.noLang) { st.noLang = true; openGeminiSocket(st); return; } // first connect refused: try without the language list
      else if (!st.basic) { st.basic = true; openGeminiSocket(st); return; } // then with the simplest setup
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
  st.lastRms = rms; // for the audio-levels readout
  const chunk = bytesToB64(new Uint8Array(pcm.buffer)); const sec = st.q.length / 16000;
  st.q = [];
  const send = (data, s = sec) => { st.sentSec += s; st.ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } })); };
  const now = st.ctx.currentTime;
  // the last half second, so nothing you say right after the partner stops is lost
  st.ring = (st.ring || []).concat({ t: now, d: chunk }).slice(-12);
  if (!echoGate(st, rms, chunk)) { send(SILENCE_40MS, 0.04); st.paused = true; return; } // partner speaking: its echo stays out
  const keep = (d) => { st.turnAudio = (st.turnAudio || []).concat(d).slice(-750); send(d, 0.04); };
  if (st.flushRing) { st.flushRing = false; st.ring.forEach((r) => keep(r.d)); st.ring = []; st.paused = false; return; }
  // Your voice measures about 0.05 and up at the mic; quieter sound is room noise, which Gemini turned into
  // odd words ("A", Hindi). So only sound from VOICE_LEVEL up opens the mic; it stays open 0.8 s after your
  // last word, and the 0.4 s before it opened is sent too, so the start of your words is never cut.
  if (rms >= VOICE_LEVEL) st.lastVoice = now;
  const speaking = st.lastVoice && now - st.lastVoice < 0.8;
  if (!speaking) { send(SILENCE_40MS, 0.04); st.paused = true; return; }
  if (st.paused) {
    const since = Math.max((st.playT || 0) + 0.3, now - 0.4);
    st.ring.filter((r) => r.t > since).forEach((r) => keep(r.d));
    st.ring = []; st.paused = false; return;
  }
  keep(chunk);
}
const VOICE_LEVEL = 0.04;
/* Echo gate. On the phone speaker the partner's voice comes back into the mic, and the browser cannot
   cancel it (the voice arrives over a WebSocket, outside the browser's echo canceller). So while the
   partner talks, and 0.6 s after, the mic is replaced by silence, except when you speak clearly louder
   than the echo: then you can interrupt. The echo level is learned during each reply.
   "Talk over the partner" (headphones) turns the gate off. */
const SILENCE_40MS = bytesToB64(new Uint8Array(1280));
function echoGate(st, rms, chunk) {
  if (S.micDuringReply === 'open') return true; // setting: always send the mic, even while the partner speaks
  const now = st.ctx.currentTime;
  // the voice comes out of the speaker a bit later than scheduled (the echo-cancellation path and the
  // iPhone's audio output add delay), so the last word would leak back without this margin
  const talking = st.playT && now < st.playT + 0.6;
  if (!talking) { st.replyStart = 0; st.gateOpenUntil = 0; st.loud = 0; return true; }
  if (!st.replyStart) { st.replyStart = now; st.echoPeak = 0; st.echoChecked = false; }
  if (now < st.gateOpenUntil) { st.gateOpenUntil = now + 1.2; return true; } // you are talking: keep it open
  const t = now - st.replyStart;
  // 1) Measure, during the first 0.6 s of each reply, how much of the partner's voice reaches the mic.
  //    If the phone's echo cancellation removes it (almost nothing arrives), the mic stays fully open:
  //    you can talk as softly as you like, even over the partner.
  if (t < 0.6) st.echoPeak = Math.max(st.echoPeak, rms);
  else if (!st.echoChecked) {
    // Only when practically nothing of the partner reaches the mic (headphones / AirPods) is the mic left open.
    // With the phone speaker some echo always arrives, often louder than a soft voice, so the mic is held back.
    st.echoChecked = true; st.aecOk = st.echoPeak < 0.003;
    if (!st.aecReported) {
      st.aecReported = true;
      setStatus(st.aecOk ? 'Headphones: you can talk softly, even while the partner speaks.'
        : 'Phone speaker: to cut in while the partner speaks, tap the hand button. When it is quiet, just talk.');
    }
  }
  if (st.echoChecked && st.aecOk) return true;
  // 2) While the partner speaks the phone turns your mic down (your voice reads about 0.03 instead of 0.05).
  //    So your voice from BARGE_LEVEL up, for 0.12 s and clearly above the partner's own echo, does what the
  //    hand button does: the partner stops at once and your words (with the 0.4 s before) go to Gemini.
  const echo = st.echoAvg ?? 0;
  if (rms >= Math.max(BARGE_LEVEL, echo * 1.6)) {
    st.loud = (st.loud || 0) + 1;
    if (st.loud >= 3) { st.loud = 0; cutInGemini(true); return true; }
    return false;
  }
  st.loud = 0;
  st.echoAvg = echo * 0.9 + rms * 0.1; // the partner's echo level while you are quiet
  return false;
}
/* Hand button: stop the partner right now and listen to you. */
const BARGE_LEVEL = 0.03;
function cutInGemini(byVoice) {
  const st = gl; if (!st || !st.ctx) return;
  cutPlayback(st); st.dropAudio = true; st.inReply = false;
  if (st.ai) { st.ai.querySelector('.txt').textContent = st.aiText.trim() + ' ...'; } // the reply stops here on screen too
  st.gateOpenUntil = st.ctx.currentTime + 4;
  if (byVoice) { st.flushRing = true; st.lastVoice = st.ctx.currentTime; } // keep what you just started saying
  else { st.flushRing = false; st.ring = []; }
  st.ws && st.ws.readyState === 1 && st.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  st.paused = true;
}
function playPcm24(st, b64) {
  if (st.dropAudio) return; // the rest of a reply you cut off
  const bytes = b64ToBytes(b64); const n = bytes.length >> 1; if (!n) return;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ab = st.ctx.createBuffer(1, n, 24000); const ch = ab.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  const src = st.ctx.createBufferSource(); src.buffer = ab; src.connect(st.out);
  // A small buffer before the partner's voice starts. If the voice runs dry in the middle of a reply
  // (slow internet), the buffer grows, so later replies play smoothly instead of in bits.
  const now = st.ctx.currentTime; st.jitter = st.jitter || 0.15;
  if (st.playT < now) {
    if (st.inReply) { st.jitter = Math.min(0.5, st.jitter + 0.1); st.underran = true; }
    st.playT = now + st.jitter;
  }
  st.inReply = true;
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
  const text = cleanScript(st.meText); const b = st.me;
  st.me = null; st.meText = '';
  b.classList.remove('pending');
  if (isNoise(text)) { b.remove(); return; } // only background noise was heard
  // Only words heard while the partner's voice was coming out of the speaker can be its echo. What you say
  // when it is quiet is always yours, even if the partner repeats your words in its reply.
  if (st.meDuringReply && isEcho(text, [st.aiText, lastAiTurn.text, st.prevAi])) { b.remove(); return; }
  const entry = { role: 'user', content: text };
  history.push(entry); history = history.slice(-16);
  const audio = st.turnAudio || []; st.turnAudio = [];
  const check = !liveTalkUserSaid(text, b) && (S.rtWritten || practiceLoop()) && corrOn();
  const turnNo = userTurnNo;
  persistChat();
  // Gemini Live's own quick transcript is shown at once. Then the same turn's audio is written down again by a
  // stronger Gemini model (English by default, Persian only for a Persian sentence) and replaces it.
  if (audio.length >= 6 && gKey) {
    b.classList.add('refining');
    betterTranscript(audio).then((better) => {
      b.classList.remove('refining');
      better = cleanScript(better || '');
      if (better && !isNoise(better)) { showBothHeard(b, text, better); entry.content = better; persistChat(); }
      if (check) writtenCorrections(entry.content, b, turnNo);
    }).catch(() => { b.classList.remove('refining'); if (check) writtenCorrections(text, b, turnNo); });
  } else if (check) writtenCorrections(text, b, turnNo);
}
/* The learner's turn, written down by gemini-3.8-flash from the exact audio that was sent to Gemini Live. */
/* When the quick live transcript and the careful one differ, show both under your words, with the words that
   differ marked, so you can see which words were heard unclearly. */
function showBothHeard(b, quick, better) {
  const tok = (s) => s.trim().split(/\s+/).filter(Boolean);
  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const q = tok(quick), c = tok(better);
  const { tHit, sHit } = align(c.map(key), q.map(key));
  const txt = b.querySelector('.txt');
  if (tHit.every(Boolean) && sHit.every(Boolean)) { txt.textContent = better; return; } // same words: nothing to compare
  const mark = (ws, hit) => ws.map((w, i) => (hit[i] ? esc(w) : `<mark>${esc(w)}</mark>`)).join(' ');
  txt.innerHTML = mark(c, tHit);
  let alt = b.querySelector('.heard-alt'); if (!alt) { alt = el('div', 'heard-alt'); b.appendChild(alt); }
  alt.innerHTML = `<span>Live call heard:</span> ${mark(q, sHit)}`;
}
/* Only English or Persian may appear in what you said. Words in any other script are dropped; Persian stays
   only when there are at least two Persian words (one stray Persian word is a mishearing). */
function cleanScript(text) {
  const ws = String(text || '').trim().split(/\s+/).filter(Boolean);
  const latin = (w) => /^[\p{Script=Latin}\p{N}\p{P}\p{S}]+$/u.test(w);
  const persian = (w) => /^[\p{Script=Arabic}\p{N}\p{P}\u200c]+$/u.test(w) && /\p{Script=Arabic}/u.test(w);
  const faCount = ws.filter(persian).length;
  return ws.filter((w) => latin(w) || (persian(w) && faCount >= 2 && S.langs !== 'en')).join(' ');
}
async function betterTranscript(chunks) {
  const parts = chunks.map(b64ToBytes); const len = parts.reduce((n, p) => n + p.length, 0);
  const wav = new DataView(new ArrayBuffer(44 + len)); const w = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); wav.setUint32(4, 36 + len, true); w(8, 'WAVE'); w(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
  wav.setUint32(24, 16000, true); wav.setUint32(28, 32000, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); w(36, 'data'); wav.setUint32(40, len, true);
  let o = 44; parts.forEach((p) => { new Uint8Array(wav.buffer, o, p.length).set(p); o += p.length; });
  const lang = S.langs === 'en'
    ? 'The speaker speaks English. Write English only.'
    : 'The speaker is an English learner and almost always speaks English: write English. Write Persian (in Persian script) only for words that are clearly Persian, and only when there are at least two Persian words. Any word you are not sure about: write your best English guess. Never use any other language or script.';
  const text = await Promise.race([
    geminiGenerate('gemini-3.8-flash', 'Transcribe exactly what the speaker says, word for word, keeping every grammar mistake, wrong word and filler like um, uh, uh-huh, mm-hmm. Do not correct, translate or comment. ' + lang,
      [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: bytesToB64(new Uint8Array(wav.buffer)) } }, { text: 'Transcribe this audio. Output only the transcript. If there is no speech, output nothing.' }] }],
      300, false, 'stt'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 8000)),
  ]);
  return String(text || '').replace(/^["\s]+|["\s]+$/g, '').trim();
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
      if (!st.started) { st.started = true; geminiSay(withPace(st.note || "Hi! Let's start.")); }
    } else {
      setStatus('You are live with Gemini. Just talk. Tap the circle to hang up.');
      if (!st.started) { st.started = true; geminiSay(withPace(st.note || 'Hi!')); }
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
  if (sc.interrupted) {
    cutPlayback(st); st.inReply = false; st.dropAudio = false;
    // Gemini stops only when it thinks you started talking; say so, in case it was a noise
    if (st.kind === 'talk') setStatus('The partner stopped because it heard something. If that was a noise, just say "go on".');
  }
  if (st.kind === 'repeat' && sc.inputTranscription && sc.inputTranscription.text) {
    st.meText += sc.inputTranscription.text; st.meStarted = true;
    $('status').textContent = 'Hearing: ' + st.meText.trim();
  } else if (sc.inputTranscription && sc.inputTranscription.text) {
    if (!st.me) {
      clearEmpty(log); st.me = bubble(log, 'me', '', { pending: true }); st.meText = '';
      st.meDuringReply = !!(st.playT && st.ctx.currentTime < st.playT + 1.5);
    }
    st.meText += sc.inputTranscription.text;
    st.me.querySelector('.txt').textContent = cleanScript(st.meText);
    scrollDown(log);
  }
  const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
  const hasAudio = parts.some((p) => p.inlineData && p.inlineData.data);
  if ((sc.outputTranscription && sc.outputTranscription.text) || hasAudio) finishMyTurn(st);
  parts.forEach((p) => { if (p.inlineData && p.inlineData.data) playPcm24(st, p.inlineData.data); });
  if (sc.outputTranscription && sc.outputTranscription.text && !st.dropAudio) {
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
    st.inReply = false; st.dropAudio = false;
    if (!st.underran && st.jitter > 0.15) st.jitter = Math.max(0.15, st.jitter - 0.05); // smooth again: shrink the buffer
    st.underran = false;
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
  if (st.stream) releaseMic(true);
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
