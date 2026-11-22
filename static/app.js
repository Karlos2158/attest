'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const DEFAULT_SETTINGS = { model: 'qwen3:14b', voice: 'baya', rate: 1, autoSpeak: true, autoNext: true, stage: 'first' };

const STAGES = {
  first: { blocks: [1, 2, 3], label: 'Первая аттестация', hint: 'Блоки 1–3: должность, технология продаж, продукт' },
  second: { blocks: [4, 5, 6], label: 'Вторая аттестация', hint: 'Блоки 4–6: презентация, возражения, сервис и отчётность' },
};

const state = {
  data: null,
  questions: [],
  byId: {},
  settings: Object.assign({}, DEFAULT_SETTINGS, safeParse(localStorage.getItem('attest_settings'))),
  stats: safeParse(localStorage.getItem('attest_stats')) || {},
  mode: 'quiz',
  quiz: { order: [], idx: 0, current: null, transcript: '' },
  exam: null,
  examTimer: null,
  askHistory: [],
  chatHistory: [],
  voices: [],
  busy: false,
  listen: null,
  player: { selected: [], voiceQ: 'baya', voiceA: 'aidar' },
};

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 4200);
}
function status(msg) { $('#statusLine').textContent = msg; }

function saveSettings() { localStorage.setItem('attest_settings', JSON.stringify(state.settings)); }
function saveStats() { localStorage.setItem('attest_stats', JSON.stringify(state.stats)); }

/* ------------------------------------------------------------------ этапы */

function stageInfo() { return STAGES[state.settings.stage] || STAGES.first; }
function stageQuestions() {
  return state.questions.filter((q) => stageInfo().blocks.includes(q.block));
}
function stageExamList() {
  const wording = {};
  (state.data.exam || []).forEach((e) => { if (e.sourceId) wording[e.sourceId] = e.question; });
  return stageQuestions().map((q) => ({
    id: q.id,
    sourceId: q.id,
    question: wording[q.id] || q.question,
  }));
}

function applyStage(stage, silent) {
  state.settings.stage = stage;
  saveSettings();
  $$('.stage').forEach((b) => {
    const on = b.dataset.stage === stage;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const info = stageInfo();
  $('#stageHint').textContent = info.hint;
  populateBlocks();
  state.quiz.current = null;
  state.quiz.order = [];
  state.exam = null;
  clearInterval(state.examTimer);
  $('#examCard').classList.add('hidden');
  $('#examResult').classList.add('hidden');
  $('#examStartCard').classList.remove('hidden');
  $('#examIntro').textContent = stageExamList().length + ' вопросов в случайном порядке. Оценка за каждый ответ, в конце — протокол.';
  $('#examTimer').textContent = '45:00';
  if (state.mode === 'quiz') startQuiz();
  fillSuggestions();
  if (state.mode === 'progress') renderProgress();
  if (typeof player !== 'undefined') {
    player.halt();
    player.sync();
    player.items = [];
    player.queue = [];
    player.release();
    if (state.mode === 'player') player.refresh();
  }
  if (!silent) toast(info.label + ': ' + stageQuestions().length + ' вопросов');
}

/* ------------------------------------------------------------------ голос */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const VOICE_LABELS = {
  baya: 'Бая', kseniya: 'Ксения', xenia: 'Ксения 2',
  aidar: 'Айдар', eugene: 'Евгений', baritone: 'Баритон', windows: 'Windows',
};

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  state.voices = window.speechSynthesis.getVoices() || [];
  const badge = $('#voiceBadge');
  const localVoice = state.settings.voice && state.settings.voice !== 'windows';
  if (localVoice) {
    badge.textContent = 'голос: ' + (VOICE_LABELS[state.settings.voice] || 'локальный') + ' ▾';
    badge.classList.remove('bad');
    return;
  }
  const ru = state.voices.filter((v) => /^ru/i.test(v.lang));
  if (!SR) {
    badge.textContent = 'нет голосового ввода';
    badge.classList.add('bad');
  } else if (ru.length) {
    const v = ru.find((x) => /irina|milena|google/i.test(x.name)) || ru[0];
    badge.textContent = 'голос: ' + v.name.split(' - ')[0].replace(/^Microsoft |^Google /, '');
    badge.classList.remove('bad');
  } else {
    badge.textContent = 'нет русского голоса';
    badge.classList.add('bad');
  }
}
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  setTimeout(loadVoices, 300);
}

function pickVoice() {
  const ru = state.voices.filter((v) => /^ru/i.test(v.lang));
  return ru.find((v) => /irina/i.test(v.name))
    || ru.find((v) => /google/i.test(v.name))
    || ru.find((v) => /milena/i.test(v.name))
    || ru[0] || null;
}

function cleanSpeech(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/[#*_`>]/g, ' ')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Локальный голос Silero приходит с сервера готовым wav.
   Длинный текст режем на фразы и проговариваем по очереди,
   следующую фразу качаем, пока звучит текущая. */

let ttsToken = 0;
let currentAudio = null;

function splitSpeech(text) {
  const parts = String(text).match(/[^.!?…]+[.!?…]*/g) || [String(text)];
  const chunks = [];
  let cur = '';
  parts.forEach((p) => {
    const s = p.trim();
    if (!s) return;
    if (cur && (cur + ' ' + s).length > 350) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? cur + ' ' + s : s;
    }
  });
  if (cur) chunks.push(cur);
  return chunks;
}

function noteSpoken(text) {
  if (!text) return;
  fetch('/api/spoken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

/* Silero пропускает номера вопросов вида «1.1» — для голоса разворачиваем их в слова.
   На экране при этом остаётся «1.1»: заменяем только текст, который уходит на синтез. */

const RU_DIGITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];

function spellDigits(s) {
  return String(s).split('').map((c) => RU_DIGITS[Number(c)] || c).join(' ');
}

function ttsNumbers(text) {
  return String(text).replace(/(^|[^\d])(\d{1,2})[.,](\d{1,2})(?!\d)/g,
    (m, pre, a, b) => pre + spellDigits(a) + ' точка ' + spellDigits(b));
}

/* Прячем номера вопросов перед делением на фразы, чтобы точка «1.1» не рвала фразу.
   Потом разворачиваем обратно: raw — для экрана, spoken — для голоса. */

function protectNumbers(text) {
  const map = [];
  const hidden = String(text).replace(/(^|[^\d])(\d{1,2})[.,](\d{1,2})(?!\d)/g, (m, pre, a, b) => {
    map.push({ raw: a + '.' + b, spoken: spellDigits(a) + ' точка ' + spellDigits(b) });
    return pre + '\uE000' + (map.length - 1) + '\uE001';
  });
  const expand = (s, field) => String(s).replace(/\uE000(\d+)\uE001/g, (m, i) => (map[Number(i)] ? map[Number(i)][field] : ''));
  return { text: hidden, raw: (s) => expand(s, 'raw'), spoken: (s) => expand(s, 'spoken') };
}

function fetchTts(text, voice) {
  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: ttsNumbers(text), voice }),
  }).then((r) => {
    if (!r.ok) throw new Error('tts ' + r.status);
    return r.blob();
  });
}

function playBlob(blob, token, text) {
  return new Promise((resolve) => {
    if (token !== ttsToken) return resolve();
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    currentAudio = a;
    noteSpoken(text);
    const rate = Number(state.settings.rate) || 1;
    a.playbackRate = Math.min(1.4, Math.max(0.7, rate));
    const done = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === a) currentAudio = null;
      resolve();
    };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}

function speakBrowser(clean) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'ru-RU';
  u.rate = Number(state.settings.rate) || 1;
  const v = pickVoice();
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
}

async function speak(text, force) {
  if (!state.settings.autoSpeak && !force) return;
  const clean = cleanSpeech(text);
  if (!clean) return;
  stopSpeak();
  const token = ttsToken;
  const voice = state.settings.voice || 'baya';
  const protectedText = protectNumbers(clean);

  if (voice !== 'windows') {
    let anyPlayed = false;
    try {
      const chunks = splitSpeech(protectedText.text);
      const cache = new Map();
      const getChunk = (i) => {
        if (!cache.has(i)) cache.set(i, fetchTts(protectedText.spoken(chunks[i]), voice));
        return cache.get(i);
      };
      const warm = (from) => {
        for (let i = from; i < Math.min(from + 3, chunks.length); i++) {
          getChunk(i).catch(() => {});
        }
      };
      warm(0);
      for (let i = 0; i < chunks.length; i++) {
        const blob = await getChunk(i);
        if (token !== ttsToken) return;
        warm(i + 3);
        await playBlob(blob, token, protectedText.raw(chunks[i]));
        anyPlayed = true;
      }
      if (token === ttsToken) clearSpeakBtn();
      return;
    } catch (e) {
      if (token !== ttsToken) return;
      if (anyPlayed) { clearSpeakBtn(); return; }
      console.warn('локальный голос недоступен, говорю голосом Windows:', e);
      toast('Локальный голос не отвечает — говорю голосом Windows. Проверьте, что окно сервера открыто.');
    }
  }
  noteSpoken(clean);
  speakBrowser(ttsNumbers(clean));
}

function stopSpeak() {
  ttsToken++;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    currentAudio = null;
  }
  clearSpeakBtn();
  if (typeof refReader !== 'undefined') refReader.halt();
  if (typeof player !== 'undefined') player.halt();
}

/* Кнопки озвучки работают как выключатель: нажали — говорит, нажали ещё раз — тишина. */

let speakBtn = null;

function markSpeakBtn(btn) {
  if (speakBtn && speakBtn !== btn) restoreSpeakBtn(speakBtn);
  speakBtn = btn;
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.classList.add('speaking');
  btn.textContent = '⏹ Остановить';
}

function restoreSpeakBtn(btn) {
  btn.classList.remove('speaking');
  btn.textContent = btn.dataset.label || '🔊 Озвучить';
}

function clearSpeakBtn() {
  if (!speakBtn) return;
  restoreSpeakBtn(speakBtn);
  speakBtn = null;
}

function toggleSpeak(text, btn) {
  if (btn && speakBtn === btn) { stopSpeak(); return; }
  if (speakBtn && speakBtn !== btn) stopSpeak();
  speak(text, true);
  markSpeakBtn(btn || null);
}

/* Чтец эталонного ответа: Плей/Стоп и «Сначала».
   Останавливается на середине фразы и продолжает ровно с того же места. */

const refReader = {
  text: '',
  chunks: [],
  urls: new Map(),
  pending: new Map(),
  idx: 0,
  offset: 0,
  audio: null,
  playing: false,
  gen: 0,
  fetchGen: 0,
  cursorChar: 0,
  playFromChar: 0,
  ta: null,

  setLabel(t) {
    const b = document.getElementById('quizRefPlay');
    if (b) b.textContent = t;
  },

  setCursor(n) {
    this.cursorChar = Math.max(0, Math.min(Number(n) || 0, this.text.length));
    this.updateHint();
  },

  updateHint() {
    const hint = document.getElementById('quizRefHint');
    if (!hint) return;
    if (!this.cursorChar) {
      hint.textContent = 'Поставьте курсор в текст — «Плей» начнёт с этого места.';
      return;
    }
    const tail = this.text.slice(this.cursorChar).replace(/\s+/g, ' ').trim();
    hint.textContent = 'Плей начнёт с: «' + tail.slice(0, 60) + (tail.length > 60 ? '…' : '') + '»';
  },

  attachTextarea(ta) {
    this.ta = ta;
    const sync = (stop) => {
      this.setCursor(ta.selectionStart);
      if (stop && this.playing) this.halt();
    };
    ta.addEventListener('click', () => sync(true));
    ta.addEventListener('keyup', () => sync(true));
    ta.addEventListener('select', () => this.setCursor(ta.selectionStart));
  },

  release() {
    this.fetchGen += 1;
    this.urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} });
    this.urls.clear();
    this.pending.clear();
  },

  load(text) {
    this.halt();
    this.release();
    this.text = String(text || '').replace(/\r\n?/g, '\n');
    this.chunks = this.text ? splitSpeech(this.text) : [];
    this.idx = 0;
    this.offset = 0;
    this.cursorChar = 0;
    this.playFromChar = 0;
    this.setLabel('▶ Плей');
    this.updateHint();
  },

  halt() {
    this.gen += 1;
    this.playing = false;
    if (this.audio) {
      try {
        if (!this.audio.ended) this.offset = this.audio.currentTime || 0;
        this.audio.pause();
      } catch (e) {}
      this.audio = null;
    }
    this.setLabel('▶ Плей');
  },

  seek(n) {
    let from = Math.max(0, Math.min(Number(n) || 0, this.text.length));
    // Если курсор попал в середину слова — начинаем с начала этого слова.
    const letter = /[А-Яа-яЁёA-Za-z0-9]/;
    if (from > 0 && from < this.text.length &&
        letter.test(this.text[from - 1]) && letter.test(this.text[from])) {
      while (from > 0 && letter.test(this.text[from - 1])) from -= 1;
    }
    this.halt();
    this.release();
    this.playFromChar = from;
    this.cursorChar = from;
    const tail = this.text.slice(from).replace(/^\s+/, '');
    this.chunks = tail ? splitSpeech(tail) : [];
    this.idx = 0;
    this.offset = 0;
    this.updateHint();
  },

  rewind() {
    this.seek(0);
  },

  restart() {
    this.seek(0);
    if (this.ta) {
      try { this.ta.setSelectionRange(0, 0); } catch (e) {}
    }
    this.play();
  },

  toggle() {
    if (this.playing) { this.halt(); return; }
    this.play();
  },

  async chunkUrl(i) {
    if (this.urls.has(i)) return this.urls.get(i);
    if (this.pending.has(i)) return this.pending.get(i);
    const gen = this.fetchGen;
    const clean = cleanSpeech(this.chunks[i]);
    const p = fetchTts(clean, state.settings.voice || 'baya').then((blob) => {
      if (gen !== this.fetchGen) throw new Error('stale tts');
      const url = URL.createObjectURL(blob);
      this.urls.set(i, url);
      this.pending.delete(i);
      return url;
    }, (e) => {
      this.pending.delete(i);
      throw e;
    });
    this.pending.set(i, p);
    return p;
  },

  warm(from) {
    for (let i = from; i < Math.min(from + 3, this.chunks.length); i++) {
      this.chunkUrl(i).catch(() => {});
    }
  },

  async play() {
    if (this.playing) return;
    if (this.cursorChar !== this.playFromChar) this.seek(this.cursorChar);
    if (!this.chunks.length) {
      toast('Поставьте курсор в текст ответа или нажмите «Сначала».');
      return;
    }
    if ((state.settings.voice || 'baya') === 'windows') {
      const tail = cleanSpeech(this.text.slice(this.playFromChar));
      noteSpoken(tail);
      speakBrowser(tail);
      return;
    }
    stopSpeak();
    this.playing = true;
    this.setLabel('⏹ Стоп');
    const my = ++this.gen;
    this.warm(this.idx);
    while (this.idx < this.chunks.length) {
      let url;
      try {
        url = await this.chunkUrl(this.idx);
      } catch (e) {
        if (my === this.gen) { this.halt(); toast('Голос не отвечает — проверьте, что окно сервера открыто.'); }
        return;
      }
      if (my !== this.gen) return;
      noteSpoken(this.chunks[this.idx]);
      const a = new Audio(url);
      a.playbackRate = Math.min(1.4, Math.max(0.7, Number(state.settings.rate) || 1));
      this.audio = a;
      if (this.offset > 0) {        const offset = this.offset;
        await new Promise((res) => {
          const setTime = () => {
            try { a.currentTime = Math.min(offset, Math.max(0, (a.duration || offset + 1) - 0.05)); } catch (e) {}
            res();
          };
          if (a.readyState >= 1) setTime(); else a.onloadedmetadata = setTime;
        });
        this.offset = 0;
        if (my !== this.gen) return;
      }
      await new Promise((res) => {
        a.onended = res;
        a.onpause = res;
        a.onerror = res;
        a.play().catch(res);
      });
      if (my !== this.gen) return;
      this.idx += 1;
      this.audio = null;
      this.warm(this.idx);
    }
    if (my === this.gen) {
      this.playing = false;
      this.idx = 0;
      this.offset = 0;
      this.setLabel('▶ Плей');
    }
  },
};

function resizeRefText() {
  const ta = document.getElementById('quizRefText');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}
window.addEventListener('resize', resizeRefText);

function listen(opts) {
  if (!SR) {
    toast('Голосовой ввод не поддерживается этим браузером. Откройте в Chrome или Edge — или печатайте текстом.');
    return;
  }
  if (state.listen) { state.listen.stop(); return; }

  const rec = new SR();
  rec.lang = 'ru-RU';
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;

  let finalText = '';
  let silence = null;
  let active = true;

  const btn = opts.btn;
  const label = opts.label;
  const ta = opts.textarea;

  const finishUI = () => {
    active = false;
    clearTimeout(silence);
    btn.classList.remove('listening');
    if (label) label.textContent = opts.idleLabel;
    if (state.listen && state.listen.rec === rec) state.listen = null;
  };

  rec.onstart = () => {
    btn.classList.add('listening');
    if (label) label.textContent = 'Слушаю… нажмите ещё раз, чтобы закончить';
    status('Слушаю…');
  };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t.trim() + ' ';
      else interim += t;
    }
    if (ta) ta.value = (finalText + interim).trim();
    clearTimeout(silence);
    if (finalText.trim()) {
      silence = setTimeout(() => { try { rec.stop(); } catch (err) {} }, 2800);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Нет доступа к микрофону. Разрешите его в настройках сайта (значок камеры/микрофона в адресной строке).');
    } else if (e.error === 'no-speech') {
      toast('Речь не распознана — попробуйте ещё раз поближе к микрофону.');
    } else if (e.error !== 'aborted') {
      toast('Ошибка распознавания: ' + e.error);
    }
  };
  rec.onend = () => {
    finishUI();
    const text = (finalText || (ta ? ta.value : '')).trim();
    if (active && text && opts.onResult) opts.onResult(text);
    status('Готов');
  };

  try { rec.start(); } catch (e) {
    toast('Не удалось запустить микрофон: ' + e.message);
    return;
  }
  state.listen = {
    rec,
    stop: () => {
      try { rec.stop(); } catch (e) {}
      setTimeout(() => { if (state.listen && state.listen.rec === rec) finishUI(); }, 300);
    },
  };
}
function stopListening() { if (state.listen) state.listen.stop(); }

/* ------------------------------------------------------------------ API */

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (data.authRequired) toast('Откройте тренажёр через Telegram — без этого вход закрыт.', 8000);
    throw new Error(data.error || ('Ошибка ' + r.status));
  }
  return data;
}

/* ------------------------------------------------------------------ Telegram Mini App */

async function initTelegram() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg || !tg.initData) return false;
  document.body.classList.add('tg-app');
  try {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('#f6f3ee');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#f6f3ee');
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) state.tgUser = data.user || null;
    else toast(data.error || 'Не удалось войти через Telegram', 8000);
  } catch (e) {
    console.warn('Telegram auth:', e);
  }
  return true;
}

/* ------------------------------------------------------------------ статистика */

function recordStat(key, score) {
  const s = state.stats[key] || { attempts: 0, total: 0, best: 0, last: 0, lastDate: null };
  s.attempts += 1;
  s.total += score;
  s.best = Math.max(s.best, score);
  s.last = score;
  s.lastDate = new Date().toISOString();
  state.stats[key] = s;
  saveStats();
}
function avgOf(key) {
  const s = state.stats[key];
  return s && s.attempts ? s.total / s.attempts : 0;
}

/* ------------------------------------------------------------------ тренировка */

const quizIds = () => stageQuestions().filter((q) => {
  const sel = $('#quizBlock').value;
  return sel === 'all' || String(q.block) === sel;
}).map((q) => q.id);

function startQuiz(ids) {
  const list = ids && ids.length ? ids.slice() : quizIds();
  if (!list.length) { toast('Нет вопросов в выбранном блоке'); return; }
  state.quiz.order = shuffle(list);
  state.quiz.idx = 0;
  showQuizQuestion(false);
  $('#quizFeedback').classList.add('hidden');
}
function showQuizQuestion(speakIt) {
  const q = state.byId[state.quiz.order[state.quiz.idx % state.quiz.order.length]];
  if (!q) return;
  state.quiz.current = q;
  $('#quizQuestion').textContent = q.question;
  $('#quizBlockChip').textContent = 'Блок ' + q.block;
  $('#quizId').textContent = 'п. ' + q.id;
  $('#quizCounter').textContent = 'Вопрос ' + (state.quiz.idx + 1) + ' из ' + state.quiz.order.length;
  $('#quizTranscript').value = '';
  $('#quizReference').classList.add('hidden');
  $('#quizReference').innerHTML = '';
  $('#quizFeedback').classList.add('hidden');
  if (speakIt !== false) speak(q.question, true);
  status('Вопрос ' + q.id + ' — отвечайте голосом или текстом');
}
function nextQuizQuestion() {
  state.quiz.idx += 1;
  if (state.quiz.idx >= state.quiz.order.length) {
    state.quiz.order = shuffle(state.quiz.order);
    state.quiz.idx = 0;
  }
  showQuizQuestion(true);
}
function setBusy(on, text) {
  state.busy = on;
  $('#quizSubmit').disabled = on;
  $('#examSubmit').disabled = on;
  $('#askSend').disabled = on;
  status(on ? (text || 'ИИ думает…') : 'Готов');
}

async function gradeQuiz() {
  const q = state.quiz.current;
  if (!q) { toast('Сначала выберите вопрос'); return; }
  const answer = $('#quizTranscript').value.trim();
  if (!answer) { toast('Сначала ответьте голосом или введите текст'); return; }
  setBusy(true, 'Проверяю ответ…');
  try {
    const res = await api('/api/grade', {
      questionId: q.id,
      studentAnswer: answer,
      model: state.settings.model,
    });
    recordStat(q.id, res.score);
    renderFeedback($('#quizFeedback'), res, q);
    speakFeedback(res);
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(false);
  }
}

function renderFeedback(el, res, q, compact) {
  const cls = res.score >= 4 ? 'ok' : res.score >= 3 ? 'warn' : 'bad';
  const list = (arr) => '<ul>' + arr.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  let html = '<div class="fb-head">' +
    '<div class="score-badge ' + cls + '">' + res.score + '<small>/5</small></div>' +
    '<div><h3>' + esc(res.verdict || (res.score >= 4 ? 'Хороший ответ' : 'Нужно доработать')) + '</h3>' +
    '<p>' + (q ? 'п. ' + esc(q.id) + ' · ' : '') +
    (res.hasReference ? 'проверено по эталону' : 'эталона в файле нет — оценка по общим критериям') +
    (res.elapsed ? ' · ' + res.elapsed + ' с' : '') + '</p></div></div>';

  if (compact) {
    el.innerHTML = html;
    el.className = 'mini-feedback ' + cls;
    el.classList.remove('hidden');
    return;
  }

  html += '<div class="fb-cols">';
  if (res.correct && res.correct.length) {
    html += '<div class="fb-block"><h4>Верно</h4>' + list(res.correct) + '</div>';
  }
  if (res.missing && res.missing.length) {
    html += '<div class="fb-block"><h4>Упущено</h4>' + list(res.missing) + '</div>';
  }
  if (res.errors && res.errors.length) {
    html += '<div class="fb-block"><h4>Неточности</h4>' + list(res.errors) + '</div>';
  }
  if (res.model_answer) {
    html += '<div class="fb-block fb-model"><h4>Как ответил бы преподаватель</h4><p>' + esc(res.model_answer) + '</p></div>';
  }
  if (res.followup) {
    html += '<div class="fb-block fb-model"><h4>Уточняющий вопрос</h4><p>' + esc(res.followup) + '</p></div>';
  }
  html += '</div>';
  html += '<div class="fb-actions">' +
    '<button class="btn ghost" data-act="say-feedback">🔊 Прослушать разбор</button>' +
    '<button class="btn primary" data-act="next-question">Следующий вопрос →</button>' +
    '</div>';

  el.className = 'card feedback ' + cls;
  el.innerHTML = html;
  el.classList.remove('hidden');
  el.querySelector('[data-act="say-feedback"]').onclick = () => speakFeedback(res, true);
  el.querySelector('[data-act="next-question"]').onclick = () => nextQuizQuestion();
}

function speakFeedback(res, force) {
  const parts = ['Оценка ' + res.score + ' из 5.'];
  if (res.verdict) parts.push(res.verdict + '.');
  if (res.missing && res.missing.length) parts.push('Ты упустила: ' + res.missing.join('; ') + '.');
  if (res.errors && res.errors.length) parts.push('Неточности: ' + res.errors.join('; ') + '.');
  if (res.model_answer) parts.push('Образец ответа: ' + res.model_answer);
  speak(parts.join(' '), force);
}

/* ------------------------------------------------------------------ экзамен */

const EXAM_SECONDS = 45 * 60;

function startExam() {
  const list = stageExamList();
  if (!list.length) { toast('Нет экзаменационных вопросов'); return; }
  state.exam = {
    list: shuffle(list),
    idx: 0,
    results: [],
    started: Date.now(),
    left: EXAM_SECONDS,
  };
  $('#examStartCard').classList.add('hidden');
  $('#examResult').classList.add('hidden');
  $('#examCard').classList.remove('hidden');
  clearInterval(state.examTimer);
  state.examTimer = setInterval(tickExam, 1000);
  showExamQuestion();
}

function tickExam() {
  if (!state.exam) return;
  state.exam.left -= 1;
  const s = Math.max(0, state.exam.left);
  $('#examTimer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  if (s <= 0) { toast('Время вышло — показываю результат'); finishExam(); }
}

function showExamQuestion() {
  const ex = state.exam;
  if (!ex) return;
  if (ex.idx >= ex.list.length) { finishExam(); return; }
  const item = ex.list[ex.idx];
  $('#examQuestion').textContent = item.question;
  $('#examCounter').textContent = 'Вопрос ' + (ex.idx + 1) + ' из ' + ex.list.length;
  $('#examTranscript').value = '';
  $('#examFeedback').classList.add('hidden');
  $('#examFeedback').innerHTML = '';
  speak(item.question, true);
  status('Экзамен: вопрос ' + (ex.idx + 1) + ' из ' + ex.list.length);
}

async function gradeExam() {
  const ex = state.exam;
  if (!ex) return;
  const answer = $('#examTranscript').value.trim();
  const item = ex.list[ex.idx];
  if (!answer) { toast('Сначала ответьте голосом (или нажмите «Пропустить»)'); return; }
  setBusy(true, 'Проверяю ответ…');
  try {
    const res = await api('/api/grade', {
      questionId: item.sourceId || '',
      question: item.question,
      reference: item.sourceId ? undefined : '',
      studentAnswer: answer,
      model: state.settings.model,
    });
    recordStat(item.sourceId || ('exam:' + item.id), res.score);
    ex.results.push({ item, res, answer });
    renderFeedback($('#examFeedback'), res, null, true);
    const nxt = document.createElement('div');
    nxt.className = 'row-actions';
    nxt.innerHTML = '<button class="btn primary" id="examNextBtn">Дальше →</button>';
    $('#examFeedback').appendChild(nxt);
    $('#examNextBtn').onclick = () => { ex.idx += 1; showExamQuestion(); };
    speak('Оценка ' + res.score + ' из 5. ' + (res.verdict || ''));
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(false);
  }
}

function finishExam() {
  const ex = state.exam;
  if (!ex) return;
  clearInterval(state.examTimer);
  const done = ex.results;
  const avg = done.length ? done.reduce((a, r) => a + r.res.score, 0) / done.length : 0;
  const counts = [0, 0, 0, 0, 0, 0];
  done.forEach((r) => counts[r.res.score]++);

  let html = '<h2>Протокол экзамена</h2>' +
    '<div class="stat-grid">' +
    '<div class="stat"><div class="num">' + avg.toFixed(1) + '</div><div class="lbl">средний балл</div></div>' +
    '<div class="stat"><div class="num">' + done.length + '</div><div class="lbl">отвечено из ' + ex.list.length + '</div></div>' +
    '<div class="stat"><div class="num">' + counts[4] + '+' + counts[5] + '</div><div class="lbl">оценок 4 и 5</div></div>' +
    '<div class="stat"><div class="num">' + (counts[0] + counts[1] + counts[2]) + '</div><div class="lbl">оценок ниже 3</div></div>' +
    '</div>';

  html += '<div class="weak-list" style="margin-top:16px">';
  done.forEach((r) => {
    const cls = r.res.score >= 4 ? 'ok' : r.res.score >= 3 ? 'warn' : 'bad';
    html += '<div class="weak-item"><span class="score score-badge ' + cls + '" style="width:38px;height:38px;font-size:15px">' +
      r.res.score + '</span><span class="q">' + esc(r.item.question) + '</span></div>';
  });
  html += '</div>';

  const weak = done.filter((r) => r.res.score < 4 && r.item.sourceId).map((r) => r.item.sourceId);
  html += '<div class="row-actions" style="margin-top:16px">' +
    '<button class="btn primary" id="examRetryWeak">Тренировать слабые (' + weak.length + ')</button>' +
    '<button class="btn ghost" id="examAgain">Ещё раз</button>' +
    '<button class="btn ghost" id="examPrint">Печать / PDF</button>' +
    '</div>';

  const box = $('#examResult');
  box.innerHTML = html;
  box.classList.remove('hidden');
  $('#examCard').classList.add('hidden');

  $('#examAgain').onclick = () => { $('#examResult').classList.add('hidden'); startExam(); };
  $('#examPrint').onclick = () => window.print();
  $('#examRetryWeak').onclick = () => {
    $('#examResult').classList.add('hidden');
    switchMode('quiz');
    startQuiz(weak.length ? weak : undefined);
  };
  state.exam = null;
  speak('Экзамен завершён. Средний балл ' + avg.toFixed(1) + ' из 5.');
}

/* ------------------------------------------------------------------ я спрашиваю */

function addMsg(role, text, sources, extraClass) {
  const div = document.createElement('div');
  div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
  div.innerHTML = esc(text).replace(/\n/g, '<br>');
  if (sources && sources.length) {
    const src = document.createElement('div');
    src.className = 'src';
    src.innerHTML = sources.map((s) => '<span>п. ' + esc(s.id) + ' · ' + esc(s.question.slice(0, 55)) + '…</span>').join('');
    div.appendChild(src);
  }
  $('#askChat').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return div;
}

async function ask(text) {
  let q = (text || '').trim();
  if (!q) { toast('Скажите или напишите вопрос'); return; }
  addMsg('user', q);
  $('#askInput').value = '';
  const thinking = addMsg('ai', 'Думаю…', null, 'thinking');
  setBusy(true, 'ИИ готовит ответ…');
  try {
    const res = await api('/api/ask', {
      question: q,
      history: state.askHistory.slice(-8),
      model: state.settings.model,
    });
    thinking.remove();
    const bubble = addMsg('ai', res.answer, res.sources);
    const btn = document.createElement('button');
    btn.className = 'speak-btn';
    btn.textContent = '🔊 Прослушать';
    btn.onclick = () => toggleSpeak(res.answer, btn);
    bubble.appendChild(btn);
    state.askHistory.push({ role: 'user', content: q });
    state.askHistory.push({ role: 'assistant', content: res.answer });
    if ($('#askAutoSpeak').checked) speak(res.answer, true);
  } catch (e) {
    thinking.remove();
    addMsg('ai', 'Не получилось: ' + e.message);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ чат с тренером */

function addChatMsg(role, text, extraClass, sources) {
  const div = document.createElement('div');
  div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
  div.innerHTML = esc(text).replace(/\n/g, '<br>');
  if (sources && sources.length) {
    const src = document.createElement('div');
    src.className = 'src';
    src.innerHTML = sources.map((s) => '<span>п. ' + esc(s.id) + ' · ' + esc(s.question.slice(0, 55)) + '…</span>').join('');
    div.appendChild(src);
  }
  $('#chatLog').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return div;
}

async function chatSend(text) {
  const q = (text || '').trim();
  if (!q) { toast('Напишите или скажите вопрос'); return; }
  addChatMsg('user', q);
  $('#chatInput').value = '';
  const thinking = addChatMsg('ai', 'Думаю…', 'thinking');
  setBusy(true, 'Тренер думает…');
  try {
    const res = await api('/api/chat', {
      question: q,
      history: state.chatHistory.slice(-12),
      model: state.settings.model,
    });
    thinking.remove();
    const bubble = addChatMsg('ai', res.answer, null, res.sources);
    const btn = document.createElement('button');
    btn.className = 'speak-btn';
    btn.textContent = '🔊 Прослушать';
    btn.onclick = () => toggleSpeak(res.answer, btn);
    bubble.appendChild(btn);
    state.chatHistory.push({ role: 'user', content: q });
    state.chatHistory.push({ role: 'assistant', content: res.answer });
    if (res.modelFallback) toast('Ключа DeepSeek нет — ответила локальная ' + res.modelFallback);
    speak(res.answer, true);
  } catch (e) {
    thinking.remove();
    addChatMsg('ai', 'Не получилось: ' + e.message);
  } finally {
    setBusy(false);
  }
}

function fillSuggestions() {
  const box = $('#askSuggestions');
  const picks = shuffle(stageQuestions()).slice(0, 4);
  box.innerHTML = '';
  picks.forEach((q) => {
    const b = document.createElement('button');
    b.className = 'suggestion';
    b.textContent = q.question.length > 48 ? q.question.slice(0, 45) + '…' : q.question;
    b.title = q.question;
    b.onclick = () => ask(q.question);
    box.appendChild(b);
  });
}

/* ------------------------------------------------------------------ прогресс */

function renderProgress() {
  const qs = stageQuestions();
  const attempted = qs.filter((q) => state.stats[q.id] && state.stats[q.id].attempts);
  const totalScore = attempted.reduce((a, q) => a + state.stats[q.id].total, 0);
  const totalAttempts = attempted.reduce((a, q) => a + state.stats[q.id].attempts, 0);
  const avg = totalAttempts ? totalScore / totalAttempts : 0;

  const blocks = {};
  qs.forEach((q) => {
    const s = state.stats[q.id];
    if (!s || !s.attempts) return;
    const b = blocks[q.block] || (blocks[q.block] = { sum: 0, n: 0, title: q.blockTitle });
    b.sum += s.total; b.n += s.attempts;
  });
  let bestBlock = null;
  Object.entries(blocks).forEach(([k, b]) => {
    b.avg = b.sum / b.n;
    if (!bestBlock || b.avg > bestBlock.avg) bestBlock = Object.assign({ block: k }, b);
  });

  $('#statGrid').innerHTML =
    '<div class="stat"><div class="num">' + totalAttempts + '</div><div class="lbl">всего ответов</div></div>' +
    '<div class="stat"><div class="num">' + (avg ? avg.toFixed(1) : '—') + '</div><div class="lbl">средний балл</div></div>' +
    '<div class="stat"><div class="num">' + attempted.length + ' / ' + qs.length + '</div><div class="lbl">вопросов пройдено</div></div>' +
    '<div class="stat"><div class="num">' + (bestBlock ? bestBlock.avg.toFixed(1) : '—') + '</div><div class="lbl">' +
    (bestBlock ? 'лучший блок ' + bestBlock.block : 'лучший блок') + '</div></div>';

  const bars = $('#blockBars');
  bars.innerHTML = '';
  Object.keys(blocks).sort().forEach((k) => {
    const b = blocks[k];
    const pct = Math.round((b.avg / 5) * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = '<span>Блок ' + esc(k) + '. ' + esc((b.title || '').slice(0, 34)) + '</span>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="bar-val">' + b.avg.toFixed(1) + ' / 5</span>';
    bars.appendChild(row);
  });
  if (!Object.keys(blocks).length) bars.innerHTML = '<p class="muted">Пока нет ответов — начните тренировку.</p>';

  const weak = qs
    .filter((q) => state.stats[q.id] && state.stats[q.id].attempts && avgOf(q.id) < 4)
    .sort((a, b) => avgOf(a.id) - avgOf(b.id))
    .slice(0, 12);

  const wl = $('#weakList');
  wl.innerHTML = '';
  if (!weak.length) {
    wl.innerHTML = '<p class="muted">Слабых вопросов нет. Отличная работа!</p>';
  } else {
    weak.forEach((q) => {
      const row = document.createElement('div');
      row.className = 'weak-item';
      row.innerHTML = '<span class="score">' + avgOf(q.id).toFixed(1) + '</span>' +
        '<span class="q">п. ' + esc(q.id) + ' · ' + esc(q.question) + '</span>' +
        '<button class="btn ghost">Тренировать</button>';
      row.querySelector('button').onclick = () => { switchMode('quiz'); startQuiz([q.id]); };
      wl.appendChild(row);
    });
  }
}

/* ------------------------------------------------------------------ плеер */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const player = {
  storageKey: 'attest_player',
  selected: new Set(),
  voiceQ: 'baya',
  voiceA: 'aidar',
  items: [],
  queue: [],
  urls: new Map(),
  pending: new Map(),
  idx: 0,
  audio: null,
  playing: false,
  token: 0,
  fetchGen: 0,
  repeatCount: 1,
  loop: false,
  round: 1,
  resumeOffset: 0,

  loadPrefs() {
    const saved = safeParse(localStorage.getItem(this.storageKey)) || {};
    this.voiceQ = saved.voiceQ || 'baya';
    this.voiceA = saved.voiceA || 'aidar';
    this.selected = new Set(Array.isArray(saved.selected) ? saved.selected : []);
    this.repeatCount = Math.max(1, Math.min(99, Number(saved.repeatCount) || 1));
    this.loop = false;
  },

  savePrefs() {
    localStorage.setItem(this.storageKey, JSON.stringify({
      selected: Array.from(this.selected),
      voiceQ: this.voiceQ,
      voiceA: this.voiceA,
      repeatCount: this.repeatCount,
    }));
  },

  setLabel(t) {
    const b = document.getElementById('playerToggle');
    if (b) b.textContent = t;
  },

  /* Оставляем в выборе только существующие вопросы (выбор общий для обоих этапов). */
  sync() {
    const ids = new Set(state.questions.map((q) => q.id));
    let changed = false;
    this.selected.forEach((id) => { if (!ids.has(id)) { this.selected.delete(id); changed = true; } });
    if (changed) this.savePrefs();
  },

  selectedQuestions() {
    return stageQuestions().filter((q) => this.selected.has(q.id));
  },

  release() {
    this.fetchGen += 1;
    this.urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} });
    this.urls.clear();
    this.pending.clear();
  },

  buildQueue() {
    this.release();
    this.items = this.selectedQuestions();
    const queue = [];
    this.items.forEach((q, qi) => {
      splitSpeech(cleanSpeech(q.question)).forEach((t) => {
        queue.push({ text: t, voice: this.voiceQ, qi, kind: 'q', id: q.id });
      });
      splitSpeech(cleanSpeech(q.answer)).forEach((t) => {
        queue.push({ text: t, voice: this.voiceA, qi, kind: 'a', id: q.id });
      });
    });
    this.queue = queue;
    this.idx = 0;
    this.round = 1;
    this.resumeOffset = 0;
    this.updateBar();
  },

  getUrl(i) {
    if (this.urls.has(i)) return Promise.resolve(this.urls.get(i));
    if (this.pending.has(i)) return this.pending.get(i);
    const gen = this.fetchGen;
    const job = this.queue[i];
    const p = fetchTts(job.text, job.voice).then((blob) => {
      if (gen !== this.fetchGen) throw new Error('stale tts');
      const url = URL.createObjectURL(blob);
      this.urls.set(i, url);
      this.pending.delete(i);
      return url;
    }, (e) => {
      this.pending.delete(i);
      throw e;
    });
    this.pending.set(i, p);
    return p;
  },

  warm(from) {
    for (let i = from; i < Math.min(from + 3, this.queue.length); i++) {
      this.getUrl(i).catch(() => {});
    }
  },

  showNow(job) {
    const now = document.getElementById('playerNow');
    if (now) {
      if (!job) {
        now.textContent = this.items.length
          ? 'Выбрано вопросов: ' + this.items.length + '. Нажмите «Плей».'
          : 'Выберите вопросы из списка и нажмите «Плей».';
      } else {
        const kind = job.kind === 'q' ? 'Вопрос ' : 'Ответ на ';
        const n = job.qi + 1;
        now.innerHTML = '<b>' + kind + esc(job.id) + '</b> · ' + n + ' из ' + this.items.length +
          ' · ' + (job.kind === 'q' ? 'голос вопросов' : 'голос ответов') + this.roundInfo();
      }
    }
    this.highlight(job ? this.queue.indexOf(job) : -1);
    this.updateBar();
  },

  highlight(qi) {
    const job = (qi != null && qi >= 0) ? this.queue[qi] : null;
    const id = job ? job.id : null;
    document.querySelectorAll('.player-row').forEach((row) => {
      row.classList.toggle('playing', !!id && row.dataset.id === id);
    });
    const active = document.querySelector('.player-row.playing');
    if (active && this.playing) active.scrollIntoView({ block: 'nearest' });
  },

  roundInfo() {
    if (this.round === 1 && !this.playing && !this.audio) return '';
    if (this.loop) return ' · круг ' + this.round;
    const total = Math.max(1, Number(this.repeatCount) || 1);
    return total > 1 ? ' · круг ' + this.round + ' из ' + total : '';
  },

  updateBar() {
    const bar = document.getElementById('playerBar');
    if (!bar) return;
    const pct = this.queue.length ? Math.round((this.idx / this.queue.length) * 100) : 0;
    bar.style.width = pct + '%';
  },

  pause() {
    this.playing = false;
    if (this.audio) { try { this.audio.pause(); } catch (e) {} }
    this.setLabel('▶ Плей');
  },

  resume() {
    this.playing = true;
    this.setLabel('⏸ Пауза');
    if (this.audio && this.audio.paused && !this.audio.ended) this.audio.play().catch(() => {});
  },

  halt() {
    this.token += 1;
    this.playing = false;
    if (this.audio) {
      try {
        if (!this.audio.ended) this.resumeOffset = this.audio.currentTime || 0;
        this.audio.pause();
      } catch (e) {}
      this.audio = null;
    }
    this.setLabel('▶ Плей');
  },

  toggle() {
    if (this.playing) { this.pause(); return; }
    if (this.audio && this.audio.paused && !this.audio.ended) { this.resume(); return; }
    this.start();
  },

  async start() {
    if (this.playing) return;
    if (!this.items.length) this.buildQueue();
    if (!this.queue.length) { toast('Отметьте вопросы в списке — и нажмите «Плей».'); return; }
    stopSpeak();
    this.playing = true;
    this.setLabel('⏸ Пауза');
    const my = ++this.token;
    let roundsDone = Math.max(0, this.round - 1);
    let firstRound = true;
    while (my === this.token) {
      if (!firstRound) this.idx = 0;
      firstRound = false;
      this.updateBar();
      this.warm(this.idx);
      while (this.idx < this.queue.length && my === this.token) {
        const job = this.queue[this.idx];
        this.showNow(job);
        let url;
        try {
          url = await this.getUrl(this.idx);
        } catch (e) {
          if (my === this.token) {
            this.halt();
            toast('Голос не отвечает — проверьте окно сервера озвучки.');
          }
          return;
        }
        if (my !== this.token) return;
        while (!this.playing && my === this.token) await sleep(120);
        if (my !== this.token) return;
        const startAt = this.resumeOffset;
        this.resumeOffset = 0;
        this.audio = null;
        await this.playUrl(url, my, job, startAt);
        if (my !== this.token) return;
        this.idx += 1;
        this.audio = null;
        this.warm(this.idx);
        this.updateBar();
      }
      if (my !== this.token) return;
      roundsDone += 1;
      const target = this.loop ? Infinity : Math.max(1, Number(this.repeatCount) || 1);
      if (roundsDone >= target) break;
      this.round = roundsDone + 1;
    }
    if (my === this.token) {
      this.playing = false;
      this.idx = 0;
      this.round = 1;
      this.resumeOffset = 0;
      this.setLabel('▶ Плей');
      this.showNow(null);
      this.highlight(-1);
      const now = document.getElementById('playerNow');
      if (now) now.textContent = 'Прослушали всё. Можно запустить снова.';
    }
  },

  playUrl(url, my, job, startAt) {
    return new Promise((resolve) => {
      const a = new Audio(url);
      this.audio = a;
      if (job) noteSpoken(job.text);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (this.audio === a) this.audio = null;
        resolve();
      };
      a.onended = done;
      a.onerror = done;
      a.ontimeupdate = () => {
        const bar = document.getElementById('playerBar');
        if (!bar || !a.duration || !this.queue.length) return;
        const pct = ((this.idx + Math.min(1, a.currentTime / a.duration)) / this.queue.length) * 100;
        bar.style.width = Math.min(100, pct).toFixed(1) + '%';
      };
      const go = () => {
        if (startAt > 0) {
          try { a.currentTime = Math.min(startAt, Math.max(0, (a.duration || startAt + 1) - 0.05)); } catch (e) {}
        }
        a.play().catch(done);
      };
      if (startAt > 0 && a.readyState < 1) a.onloadedmetadata = go; else go();
      const tick = () => {
        if (settled) return;
        if (my !== this.token) {
          try { a.pause(); } catch (e) {}
          done();
          return;
        }
        if (!this.playing && !a.paused) { try { a.pause(); } catch (e) {} }
        if (this.playing && a.paused && !a.ended) a.play().catch(() => {});
        setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
    });
  },

  stop() {
    this.halt();
    this.showNow(this.queue[this.idx] || null);
    const now = document.getElementById('playerNow');
    if (now && this.queue[this.idx]) now.innerHTML += ' · остановлено, «Плей» продолжит отсюда';
    this.updateBar();
  },

  jump(delta) {
    if (!this.items.length) { this.buildQueue(); this.renderList(); }
    if (!this.queue.length) return;
    const curQi = this.queue[this.idx] ? this.queue[this.idx].qi : 0;
    const target = Math.max(0, Math.min(this.items.length - 1, curQi + delta));
    const newIdx = this.queue.findIndex((j) => j.qi === target);
    const was = this.playing;
    this.halt();
    this.idx = newIdx >= 0 ? newIdx : 0;
    this.showNow(this.queue[this.idx] || null);
    if (was) this.start();
  },

  updateCount() {
    const el = document.getElementById('playerCount');
    if (el) el.textContent = this.selectedQuestions().length + ' выбрано';
  },

  rowState(q) {
    const parts = [];
    if (q.question) parts.push('вопрос');
    if (q.answer) parts.push('ответ');
    return parts.join(' + ');
  },

  renderList() {
    const list = document.getElementById('playerList');
    if (!list) return;
    const term = (document.getElementById('playerSearch') || {}).value || '';
    const t = term.toLowerCase().trim();
    const qs = stageQuestions().filter((q) => !t ||
      String(q.id).toLowerCase().includes(t) ||
      String(q.question).toLowerCase().includes(t));
    const qiOf = {};
    this.items.forEach((q, i) => { qiOf[q.id] = i; });
    list.innerHTML = '';
    if (!qs.length) {
      list.innerHTML = '<div class="player-empty">Ничего не найдено.</div>';
      return;
    }
    let lastBlock = null;
    qs.forEach((q) => {
      if (q.block !== lastBlock) {
        lastBlock = q.block;
        const head = document.createElement('div');
        head.className = 'player-block';
        head.textContent = q.block + '. ' + (q.blockTitle || '');
        list.appendChild(head);
      }
      const row = document.createElement('label');
      row.className = 'player-row';
      row.dataset.id = q.id;
      if (qiOf[q.id] != null) row.dataset.qi = qiOf[q.id];
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.qid = q.id;
      cb.checked = this.selected.has(q.id);
      cb.onchange = () => this.toggleSelect(q.id, cb.checked);
      const pid = document.createElement('span');
      pid.className = 'pid';
      pid.textContent = q.id;
      const text = document.createElement('span');
      text.className = 'ptext';
      text.textContent = q.question;
      const st = document.createElement('span');
      st.className = 'pstate';
      st.textContent = this.rowState(q);
      row.append(cb, pid, text, st);
      list.appendChild(row);
    });
  },

  toggleSelect(id, on) {
    if (on) this.selected.add(id); else this.selected.delete(id);
    this.savePrefs();
    this.updateCount();
    if (this.playing) this.halt();
    this.buildQueue();
    this.highlight(-1);
    this.showNow(null);
  },

  selectVisible(on) {
    const term = (document.getElementById('playerSearch') || {}).value || '';
    const t = term.toLowerCase().trim();
    stageQuestions().forEach((q) => {
      const visible = !t || String(q.id).toLowerCase().includes(t) ||
        String(q.question).toLowerCase().includes(t);
      if (!visible) return;
      if (on) this.selected.add(q.id); else this.selected.delete(q.id);
    });
    this.savePrefs();
    this.updateCount();
    if (this.playing) this.halt();
    this.buildQueue();
    this.renderList();
    this.showNow(null);
  },

  async loadVoiceOptions() {
    let voices = [];
    try {
      const r = await fetch('/api/tts/voices');
      const j = await r.json();
      voices = j.voices || [];
    } catch (e) { voices = []; }
    if (!voices.length) voices = ['baya', 'aidar', 'baritone', 'kseniya', 'xenia', 'eugene'];
    const fill = (sel, current) => {
      if (!sel) return;
      sel.innerHTML = '';
      voices.forEach((v) => {
        const o = document.createElement('option');
        o.value = v;
        const label = VOICE_LABELS[v] || (v.charAt(0).toUpperCase() + v.slice(1));
        o.textContent = label;
        sel.appendChild(o);
      });
      if (!voices.includes(current)) current = voices[0];
      sel.value = current;
      return current;
    };
    this.voiceQ = fill(document.getElementById('playerVoiceQ'), this.voiceQ) || voices[0];
    this.voiceA = fill(document.getElementById('playerVoiceA'), this.voiceA) || voices[0];
    this.savePrefs();
  },

  refresh() {
    this.sync();
    this.updateCount();
    const selQ = document.getElementById('playerVoiceQ');
    const selA = document.getElementById('playerVoiceA');
    if (selQ) selQ.value = this.voiceQ;
    if (selA) selA.value = this.voiceA;
    const rep = document.getElementById('playerRepeat');
    if (rep) { rep.value = this.repeatCount; rep.disabled = this.loop; }
    const loopBtn = document.getElementById('playerLoop');
    if (loopBtn) loopBtn.classList.toggle('on', this.loop);
    this.buildQueue();
    this.renderList();
    this.showNow(null);
  },
};

/* ------------------------------------------------------------------ режимы */

function switchMode(mode) {
  stopListening();
  stopSpeak();
  state.mode = mode;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $$('.mode').forEach((s) => s.classList.toggle('active', s.id === 'mode-' + mode));
  if (mode === 'progress') renderProgress();
  if (mode === 'player') player.refresh();
  if (mode === 'quiz' && !state.quiz.current) startQuiz();
  if (mode === 'exam' && !state.exam) {
    $('#examStartCard').classList.remove('hidden');
    $('#examCard').classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ инициализация */

function populateBlocks() {
  const sel = $('#quizBlock');
  const prev = sel.value;
  sel.innerHTML = '<option value="all">Все блоки</option>';
  const blocks = {};
  stageQuestions().forEach((q) => { blocks[q.block] = q.blockTitle; });
  Object.keys(blocks).sort((a, b) => a - b).forEach((k) => {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = 'Блок ' + k + '. ' + blocks[k].slice(0, 40);
    sel.appendChild(o);
  });
  if (prev !== 'all' && blocks[prev]) sel.value = prev;
}

async function loadData() {
  const data = await fetch('/api/questions').then((r) => r.json());
  state.data = data;
  state.questions = data.questions;
  state.byId = {};
  data.questions.forEach((q) => { state.byId[q.id] = q; });
  populateBlocks();
}

function applyVoice(v) {
  state.settings.voice = v;
  saveSettings();
  const sel = $('#voiceSelect');
  if (sel) sel.value = v;
  loadVoices();
}

function buildVoiceMenu() {
  const menu = $('#voiceMenu');
  const order = ['baya', 'aidar', 'baritone', 'eugene', 'kseniya', 'xenia', 'windows'];
  menu.innerHTML = '<div class="vm-note">Выберите голос — он сразу проговорит пробную фразу</div>';
  order.forEach((v) => {
    const b = document.createElement('button');
    b.textContent = v === 'windows' ? 'Windows «Ирина» (запасной)' : VOICE_LABELS[v];
    if (v === state.settings.voice) b.classList.add('active');
    b.onclick = (e) => {
      e.stopPropagation();
      applyVoice(v);
      menu.classList.add('hidden');
      const label = VOICE_LABELS[v] || v;
      toast('Голос: ' + label);
      speak('Это голос ' + label + '. Так лучше?', true);
    };
    menu.appendChild(b);
  });
}

const MODEL_LABELS = { 'deepseek-v4.1-flash-free': 'DeepSeek V4.1' };

function modelLabel(id) {
  return MODEL_LABELS[id] || id;
}

function bindSettings() {
  const model = $('#modelSelect');
  if (!Array.from(model.options).some((o) => o.value === state.settings.model)) {
    state.settings.model = 'qwen3:14b';
    saveSettings();
  }
  model.value = state.settings.model;
  model.onchange = () => {
    state.settings.model = model.value;
    saveSettings();
    $('#modelBadge').textContent = 'ИИ: ' + modelLabel(model.value);
  };
  $('#modelBadge').textContent = 'ИИ: ' + modelLabel(state.settings.model);

  const rate = $('#rateSlider');
  rate.value = state.settings.rate;
  $('#rateValue').textContent = Number(state.settings.rate).toFixed(2);
  rate.oninput = () => {
    state.settings.rate = Number(rate.value);
    $('#rateValue').textContent = state.settings.rate.toFixed(2);
    saveSettings();
  };

  const auto = $('#autoSpeakSetting');
  auto.checked = state.settings.autoSpeak;
  auto.onchange = () => { state.settings.autoSpeak = auto.checked; saveSettings(); };

  const voice = $('#voiceSelect');
  voice.value = state.settings.voice || 'baya';
  voice.onchange = () => {
    applyVoice(voice.value);
    speak('Привет! Это мой новый голос. Нравится?', true);
  };

  const badge = $('#voiceBadge');
  badge.title = 'Нажмите, чтобы выбрать голос';
  badge.onclick = (e) => {
    e.stopPropagation();
    buildVoiceMenu();
    const menu = $('#voiceMenu');
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    const r = badge.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 8) + 'px';
    menu.style.right = Math.round(window.innerWidth - r.right) + 'px';
    menu.classList.remove('hidden');
  };
  document.addEventListener('click', () => $('#voiceMenu').classList.add('hidden'));

  const vStatus = $('#voiceStatus');
  fetch('/api/tts/voices').then((r) => r.json()).then((d) => {
    if (d.ready) vStatus.textContent = 'локальный голос готов';
    else vStatus.textContent = 'голос загружается…';
  }).catch(() => { vStatus.textContent = 'голос недоступен, будет Windows'; });
  $('#voiceTest').onclick = () => speak('Привет! Это проверка голоса тренажёра. Раз, два, три.', true);

  const autoNext = $('#autoNext');
  autoNext.checked = state.settings.autoNext;
  autoNext.onchange = () => { state.settings.autoNext = autoNext.checked; saveSettings(); };

  $('#resetStats').onclick = () => {
    if (!confirm('Сбросить весь прогресс и статистику ответов?')) return;
    state.stats = {};
    saveStats();
    renderProgress();
    toast('Прогресс сброшен');
  };

  // ключ DeepSeek
  const keyStatus = $('#keyStatus');
  fetch('/api/config').then((r) => r.json()).then((c) => {
    keyStatus.textContent = c.hasDeepseekKey
      ? 'ключ сохранён — можно выбрать модель DeepSeek'
      : 'ключ не задан — работает локальная модель';
  }).catch(() => { keyStatus.textContent = 'не удалось проверить ключ'; });

  $('#saveKey').onclick = async () => {
    const key = $('#deepseekKey').value.trim();
    if (!key) { toast('Вставьте ключ DeepSeek'); return; }
    try {
      const res = await api('/api/config', { deepseek_api_key: key });
      keyStatus.textContent = res.hasDeepseekKey ? 'ключ сохранён' : 'ключ не сохранён';
      $('#deepseekKey').value = '';
      toast('Ключ DeepSeek сохранён. Выберите модель DeepSeek в списке выше.');
    } catch (e) { toast(e.message); }
  };
}

function bindUI() {
  $$('.tab').forEach((t) => { t.onclick = () => switchMode(t.dataset.mode); });
  $$('.stage').forEach((b) => { b.onclick = () => applyStage(b.dataset.stage); });
  $('#settingsBtn').onclick = () => switchMode('progress');

  // плеер
  $('#playerToggle').onclick = () => player.toggle();
  $('#playerStop').onclick = () => player.stop();
  $('#playerPrev').onclick = () => player.jump(-1);
  $('#playerNext').onclick = () => player.jump(1);
  $('#playerSearch').oninput = () => player.renderList();
  $('#playerSelectAll').onclick = () => player.selectVisible(true);
  $('#playerClearAll').onclick = () => player.selectVisible(false);
  $('#playerVoiceQ').onchange = (e) => {
    player.voiceQ = e.target.value;
    player.savePrefs();
    if (player.playing) player.halt();
    player.buildQueue();
    toast('Голос вопросов: ' + (VOICE_LABELS[player.voiceQ] || player.voiceQ));
  };
  $('#playerVoiceA').onchange = (e) => {
    player.voiceA = e.target.value;
    player.savePrefs();
    if (player.playing) player.halt();
    player.buildQueue();
    toast('Голос ответов: ' + (VOICE_LABELS[player.voiceA] || player.voiceA));
  };
  $('#playerRepeat').onchange = (e) => {
    const v = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
    player.repeatCount = v;
    e.target.value = v;
    player.savePrefs();
    if (player.playing) player.showNow(player.queue[player.idx]);
  };
  $('#playerLoop').onclick = () => {
    player.loop = !player.loop;
    $('#playerLoop').classList.toggle('on', player.loop);
    $('#playerRepeat').disabled = player.loop;
    toast(player.loop ? 'Бесконечный повтор включён' : 'Бесконечный повтор выключен');
    if (player.playing) player.showNow(player.queue[player.idx]);
  };

  // тренировка
  $('#quizNew').onclick = () => startQuiz();
  $('#quizBlock').onchange = () => startQuiz();
  $('#quizRepeat').onclick = () => {
    if (state.quiz.current) toggleSpeak(state.quiz.current.question, $('#quizRepeat'));
  };
  $('#quizSubmit').onclick = gradeQuiz;
  $('#quizSkip').onclick = nextQuizQuestion;
  $('#quizShowRef').onclick = () => {
    const q = state.quiz.current;
    if (!q) return;
    const box = $('#quizReference');
    if (!box.classList.contains('hidden')) {
      box.classList.add('hidden');
      stopSpeak();
      return;
    }
    box.innerHTML = '<div class="ref-head"><b>Эталонный ответ (п. ' + esc(q.id) + ')</b>' +
      '<span class="ref-actions">' +
      '<button class="btn ghost" id="quizRefPlay">▶ Плей</button>' +
      '<button class="btn ghost" id="quizRefRestart">⟲ Сначала</button>' +
      '</span></div>' +
      '<div class="ref-hint" id="quizRefHint">Поставьте курсор в текст — «Плей» начнёт с этого места.</div>' +
      '<textarea id="quizRefText" class="ref-text" readonly spellcheck="false"></textarea>';
    box.classList.remove('hidden');
    const refText = $('#quizRefText');
    refReader.load(q.answer);
    refText.value = refReader.text;
    refReader.attachTextarea(refText);
    resizeRefText();
    $('#quizRefPlay').onclick = () => refReader.toggle();
    $('#quizRefRestart').onclick = () => refReader.restart();
  };
  $('#quizMic').onclick = () => listen({
    btn: $('#quizMic'), label: $('#quizMicLabel'), textarea: $('#quizTranscript'),
    idleLabel: 'Ответить голосом', onResult: () => {},
  });

  // экзамен
  $('#examStart').onclick = startExam;
  $('#examSubmit').onclick = gradeExam;
  $('#examRepeat').onclick = () => {
    if (state.exam) toggleSpeak(state.exam.list[state.exam.idx].question, $('#examRepeat'));
  };
  $('#examSkip').onclick = () => {
    if (!state.exam) return;
    state.exam.results.push({
      item: state.exam.list[state.exam.idx],
      res: { score: 0, verdict: 'Пропущено', correct: [], missing: [], errors: [], model_answer: '', hasReference: false },
      answer: '',
    });
    state.exam.idx += 1;
    showExamQuestion();
  };
  $('#examFinish').onclick = () => finishExam();
  $('#examMic').onclick = () => listen({
    btn: $('#examMic'), label: $('#examMicLabel'), textarea: $('#examTranscript'),
    idleLabel: 'Ответить голосом', onResult: () => {},
  });

  // спрашиваю
  $('#askSend').onclick = () => ask($('#askInput').value);
  $('#askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#askInput').value); }
  });
  $('#askMic').onclick = () => listen({
    btn: $('#askMic'), label: $('#askMicLabel'), textarea: $('#askInput'),
    idleLabel: 'Задать вопрос голосом', onResult: (text) => ask(text),
  });

  // чат
  $('#chatSend').onclick = () => chatSend($('#chatInput').value);
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend($('#chatInput').value); }
  });
  $('#chatMic').onclick = () => listen({
    btn: $('#chatMic'), label: null, textarea: $('#chatInput'),
    idleLabel: '', onResult: (text) => { $('#chatInput').value = text; chatSend(text); },
  });
  $('#chatClear').onclick = () => {
    state.chatHistory = [];
    $('#chatLog').innerHTML = '';
    stopSpeak();
    toast('Начат новый диалог');
  };

  // пробел — микрофон в режиме тренировки
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (state.mode === 'quiz') { e.preventDefault(); $('#quizMic').click(); }
  });
}

async function init() {
  bindUI();
  bindSettings();
  player.loadPrefs();
  await initTelegram();
  try {
    await loadData();
    applyStage(state.settings.stage, true);
    fillSuggestions();
    renderProgress();
    player.sync();
    player.renderList();
    player.updateCount();
    const rep = $('#playerRepeat');
    if (rep) rep.value = player.repeatCount;
    player.loadVoiceOptions();
    status('Готов — выберите режим');
  } catch (e) {
    toast('Не удалось загрузить вопросы: ' + e.message, 8000);
    status('Ошибка загрузки данных');
  }
}

init();
