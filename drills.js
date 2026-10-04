/* EN Speaking: the Drills tab. Three drills share one card, the Next button and the same flow
   (live call or turn by turn):
   - repeat:    Repeat after me (the original drill, handled in app.js and gemini.js)
   - translate: Persian -> English. The partner gives a Persian sentence, you say it in English,
                it corrects you and gives the natural American version to repeat.
   - words:     Key words. The partner teaches one important word of the topic, gives an example
                (optionally: repeat it, then make your own sentence with the word).
   The partner moves on only when you tap Next. */
'use strict';

const DRILLS = {
  repeat: { head: 'Say this sentence', next: 'Next sentence', ask: 'Next sentence, please.', start: 'Tap Next sentence to begin.' },
  translate: { head: 'Say this in English', next: 'Next sentence', ask: 'Next sentence, please.', start: 'Tap Next sentence to begin.' },
  words: { head: 'Key word', next: 'Next word', ask: 'Next word, please.', start: 'Tap Next word to begin.' },
};
const drillMeta = () => DRILLS[S.drill] || DRILLS.repeat;

/* ---------- live instructions for the two new drills ---------- */
const REPEAT_LOOP = 'While there is a sentence to repeat, keep the learner on it: after every try, give very short feedback (what was right, which words were missed or wrong), then say the same sentence again and end the turn again with exactly "Repeat after me: <the same sentence>". Even when the try was perfect, praise briefly and end the same way so they can practice it once more. Keep doing this until the learner says the next request; never stop asking them to repeat it on your own.';
function drillInstructions() {
  const lvl = `The learner's level is CEFR ${S.level}.`;
  const topic = $('topic').value.trim();
  const start = topic ? `The topic is: ${topic}. Start right away.` : 'At the very start, ask once, in one short sentence, what topic or situation they want. If they do not know or give no clear answer, choose an interesting everyday topic yourself and start; never ask for the topic again.';
  const common = `${lvl} ${start} Never move on by yourself: stay on the current item until the learner says "${drillMeta().ask}". Be patient: the learner may stop to think in the middle of a sentence; wait until they have clearly finished before you answer. ${settingsRule('repeat')}`;
  if (S.drill === 'translate') {
    return `You run a Persian-to-English speaking drill for an adult learner. For each item, say one natural Persian (Farsi) sentence that fits the topic, ${drillLength()} when translated, something people really say in daily life. End that turn with exactly this pattern and nothing after it: "In English, please: <the Persian sentence in Persian script>". Then stop and wait while the learner thinks and answers in English. When they answer, say briefly what was right and what was wrong (focus on the words that matter), then give the natural, everyday American English way to say it and end that turn with exactly: "Repeat after me: <the English sentence>". ${REPEAT_LOOP} ${common}`;
  }
  const steps = [
    'say the word or phrase and explain its meaning simply in English, in one or two short sentences',
    'give one natural example sentence with it',
  ];
  if (S.wordRepeat) steps.push('end that turn with exactly: "Repeat after me: <the example sentence>"' + (S.wordOwn ? ', and keep them on it for a few tries until it sounds good' : '. ' + REPEAT_LOOP));
  if (S.wordOwn) steps.push('when they have repeated it well (or right away if they did not need to), end a turn with exactly: "Your turn: make your own sentence with <the word>." Then correct their sentence briefly and give a natural version');
  return `You teach key words for an adult learner, one word or short phrase at a time: the important, useful or specialist words of the topic. For each word, start the turn with exactly "Key word: <the word>." then ${steps.join(', then ')}. ${common}`;
}

/* ---------- reading the partner's turn in a live drill ---------- */
/* Updates the card from what the partner just said. Returns true if the bubble should keep only the text
   before "Repeat after me" (the sentence itself is on the card). */
function applyDrillTurn(text) {
  const t = String(text || '');
  if (S.drill === 'repeat') return null; // the original drill keeps its own handling
  const low = t.toLowerCase();
  if (S.drill === 'words') {
    const m = t.match(/key word:\s*([^\n.!?]{1,60})/i);
    if (m && (!target || target.prompt !== m[1].trim())) setDrillItem({ prompt: m[1].trim(), sentence: '', stage: 'listen' });
  }
  if (S.drill === 'translate') {
    const all = [...t.matchAll(/in english,?\s*please/gi)]; const mm = all[all.length - 1];
    const i = mm ? mm.index : -1;
    if (i >= 0) {
      const fa = t.slice(i + mm[0].length).replace(/^\s*[:,.\-]?\s*/, '').replace(/^["“]|["”]\s*$/g, '').trim();
      if (fa && (!target || target.prompt !== fa)) setDrillItem({ prompt: fa, sentence: '', stage: 'answer' });
    }
  }
  const d = parseDrill(t);
  const ri = low.lastIndexOf('repeat after me'); const yi = low.lastIndexOf('your turn');
  if (d && ri > yi && !target) setDrillItem({ prompt: '', sentence: '', stage: 'repeat' });
  if (d && ri > yi && target) {
    if (target.sentence !== d.sentence) attempts = 0;
    target.sentence = d.sentence; target.stage = 'repeat';
    renderDrillCard(); setStatus('Now repeat the sentence.');
  } else if (yi >= 0 && target) {
    target.stage = 'own'; renderDrillCard(); setStatus('Now make your own sentence with the word.');
  } else if (S.drill === 'translate' && target && target.stage === 'answer') setStatus('Say it in English. Take your time.');
  return d;
}
function setDrillItem(item) {
  target = Object.assign({ focus: '' }, item); attempts = 0;
  renderDrillCard();
}
function renderDrillCard() {
  const m = drillMeta();
  $('drillHead').textContent = S.drill === 'words' && target && target.stage === 'own' ? 'Make your own sentence with' : m.head;
  $('nextSentence').textContent = m.next;
  if (!target) { $('target2').hidden = true; return; }
  if (S.drill === 'repeat') { $('target').textContent = target.sentence; $('target2').hidden = true; return; }
  $('target').textContent = target.prompt || '';
  $('target').setAttribute('dir', 'auto');
  $('target2').textContent = target.sentence || '';
  $('target2').hidden = !target.sentence;
  syncDrillButtons();
}
/* Hear again / Slowly: always usable in a live drill (they only ask the partner); turn by turn they need something to say. */
function syncDrillButtons() {
  const live = (typeof gl !== 'undefined' && gl && gl.kind === 'repeat') || (typeof rt !== 'undefined' && rt && rt.kind === 'repeat');
  const on = live || !!(target && (target.sentence || target.prompt));
  $('hearAgain').disabled = !on; $('hearSlow').disabled = !on;
}
/* What Hear again / Slowly ask the partner for in a live drill, matching what is on the card. */
function liveAgainRequest(slow) {
  const how = slow ? ', slowly and clearly' : '';
  const s = target && target.sentence;
  if (s && (S.drill === 'repeat' || target.stage === 'repeat')) return `Please say "${s}" again${how}, then let me repeat it. End with "Repeat after me: ${s}".`;
  if (S.drill === 'translate') return `Please say the Persian sentence again${how}${target && target.prompt ? ` ("${target.prompt}")` : ''}, then wait for my English.`;
  if (S.drill === 'words') return `Please say the key word${target && target.prompt ? ` "${target.prompt}"` : ''}, its meaning and the example again${how}.`;
  return `Please say the sentence again${how}, then let me repeat it.`;
}
/* What you said in a live drill: compared word by word only when there is a sentence to repeat. */
function drillUserSaid(text) {
  if (!text) return;
  if (target && target.sentence && target.stage === 'repeat') { renderAttempt(text); return; }
  const log = $('repeatLog'); clearEmpty(log); bubble(log, 'me', text);
}

/* ---------- turn by turn ---------- */
async function nextDrillItem() {
  if (!needKeys([S.chatModel])) return;
  unlockAudio(); stopSpeaking();
  setPhase('think'); setStatus(S.drill === 'words' ? 'Choosing a word...' : 'Choosing a sentence...');
  const topic = $('topic').value.trim() || 'an everyday topic of your choice';
  try {
    if (S.drill === 'translate') {
      const out = await chatJSON([{ role: 'system', content: [
        `Give one natural Persian (Farsi) sentence for an adult English learner at CEFR ${S.level} to translate into English. Topic: ${topic}. When translated it should be ${drillLength()}, something people really say in daily life.`,
        'Return only JSON: {"persian":"the sentence in Persian script","english":"the natural, everyday American English way to say it"}',
      ].join('\n') }, { role: 'user', content: 'Do not reuse any of these: ' + JSON.stringify(usedSentences.slice(-25)) }], 200);
      const fa = String(out.persian || '').trim(); if (!fa) throw new Error('No sentence came back. Tap Next sentence again.');
      usedSentences.push(fa); usedSentences = usedSentences.slice(-60); store.set('ens.used', usedSentences);
      setDrillItem({ prompt: fa, sentence: '', answer: String(out.english || '').trim(), stage: 'answer' });
      await speak('Say this in English. Take your time.');
      setStatus('Say it in English. Take your time.');
    } else {
      const out = await chatJSON([{ role: 'system', content: [
        `Teach one important, useful key word or short phrase for an adult English learner at CEFR ${S.level}. Topic: ${topic}.`,
        'Return only JSON: {"word":"...","meaning":"a simple explanation in one or two short English sentences","example":"one natural example sentence using it"}',
      ].join('\n') }, { role: 'user', content: 'Do not reuse any of these: ' + JSON.stringify(usedSentences.slice(-25)) }], 250);
      const w = String(out.word || '').trim(); if (!w) throw new Error('No word came back. Tap Next word again.');
      usedSentences.push(w); usedSentences = usedSentences.slice(-60); store.set('ens.used', usedSentences);
      const ex = String(out.example || '').trim();
      setDrillItem({ prompt: w, sentence: S.wordRepeat ? ex : '', example: ex, stage: S.wordRepeat ? 'repeat' : (S.wordOwn ? 'own' : 'listen') });
      if (!S.wordRepeat) { $('target2').textContent = ex; $('target2').hidden = !ex; }
      const log = $('repeatLog'); clearEmpty(log);
      bubble(log, 'ai', `${w}: ${String(out.meaning || '').trim()} Example: ${ex}`, { play: true });
      await speak(`${w}. ${String(out.meaning || '').trim()} For example: ${ex}` + (S.wordRepeat ? ' Now repeat after me. ' + ex : (S.wordOwn ? ` Now make your own sentence with ${w}.` : '')));
      setStatus(S.wordRepeat ? 'Now repeat the example.' : S.wordOwn ? 'Now make your own sentence with the word.' : 'Tap Next word when you are ready.');
    }
  } catch (e) { setPhase('idle'); setStatus(e.message, true); }
}
async function handleDrillTurn(text) {
  if (!target) { setPhase('idle'); setStatus(drillMeta().start); return; }
  const log = $('repeatLog');
  if (target.stage === 'repeat' && target.sentence) {
    const pct = renderAttempt(text);
    if (S.drill === 'words' && S.wordOwn && pct >= 80) {
      target.stage = 'own'; target.sentence = ''; renderDrillCard();
      $('target2').textContent = target.example || ''; $('target2').hidden = !target.example;
      await speak(`Good. Now make your own sentence with ${target.prompt}.`);
      setStatus('Now make your own sentence with the word.');
    } else if (pct === 100) { await speak(`Perfect. Say it again, or tap ${drillMeta().next}.`); setStatus(`Perfect. Say it again, or tap ${drillMeta().next}.`); }
    else { await speak('Listen again. ' + target.sentence, Number(S.rate) * 0.9); setStatus(`Red words were missed. Try again, or tap ${drillMeta().next}.`); }
    setPhase('idle'); return;
  }
  clearEmpty(log); bubble(log, 'me', text);
  setPhase('think'); setStatus('Checking...');
  try {
    const task = S.drill === 'translate'
      ? `The learner had to say this Persian sentence in English: "${target.prompt}". A good answer is: "${target.answer || ''}". Judge their English: meaning and grammar. Accept any natural answer with the same meaning.`
      : `The learner had to make their own sentence with the key word "${target.prompt}". Judge whether they used the word correctly and the grammar.`;
    const out = await chatJSON([{ role: 'system', content: [task, settingsRule('checker'),
      'Return only JSON: {"mistakes":[{"wrong":"their words","right":"corrected words","why":"short explanation"}],"corrected":"the natural American English version of what they meant","spoken_fix":"one or two short sentences of feedback to say aloud"}',
    ].join('\n') }, { role: 'user', content: text }], 300);
    renderFix(log, out);
    const fixed = String(out.corrected || target.answer || '').trim();
    if (S.drill === 'translate' && fixed) { target.sentence = fixed; target.stage = 'repeat'; attempts = 0; renderDrillCard(); }
    await speak(String(out.spoken_fix || '').trim() + (S.drill === 'translate' && fixed ? ' Now repeat after me. ' + fixed : ''));
    setStatus(S.drill === 'translate' ? `Repeat the sentence, or tap ${drillMeta().next}.` : `Try another sentence, or tap ${drillMeta().next}.`);
  } catch (e) { setStatus(e.message, true); }
  setPhase('idle');
}

/* ---------- switching drills ---------- */
function setDrill(d) {
  if (S.drill === d) return;
  S.drill = d; saveSettings();
  target = null; attempts = 0; $('focus').textContent = ''; $('repeatLog').innerHTML = ''; emptyState(); renderDrillCard(); syncDrillModes(); syncTargetHint();
  if ((gl && gl.kind === 'repeat') || (rt && rt.kind === 'repeat')) {
    liveSettingsChanged({ repeat: "Let's do the repeat-after-me drill now.", translate: "Let's do the Persian to English drill now.", words: "Let's do the key words drill now." }[d]);
  } else setStatus(drillMeta().start);
}
function syncDrillModes() {
  document.querySelectorAll('#drillModes .tm').forEach((b) => b.setAttribute('aria-checked', b.dataset.dm === S.drill ? 'true' : 'false'));
  $('drillModes').hidden = mode !== 'repeat';
  renderDrillCard();
}

/* ---------- Key word button in the Conversation tab ---------- */
function keyWordRequest() {
  return 'Teach me one important key word or phrase from what we are talking about: explain it simply and give one English example sentence.' +
    (S.wordRepeat ? ' Then end with "Repeat after me: <the example>".' : '') +
    (S.wordOwn ? ' After I repeat it, ask me to make my own sentence with the word and correct it.' : '') +
    ' Then go back to our conversation.';
}
function setupDrills() {
  document.querySelectorAll('#drillModes .tm').forEach((b) => b.addEventListener('click', () => setDrill(b.dataset.dm)));
  $('keyWordBtn').addEventListener('click', () => {
    unlockAudio();
    if (gl) { geminiSay(keyWordRequest()); setStatus('Asking for a key word...'); return; }
    if (rt && rt.dc && rt.dc.readyState === 'open') { rtSay(keyWordRequest()); setStatus('Asking for a key word...'); return; }
    if (usesCall()) { setStatus('Start the call first, then tap Key word.'); return; }
    handleTalk(keyWordRequest(), true, { label: 'Key word, please' });
  });
  syncDrillModes();
}
