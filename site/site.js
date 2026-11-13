'use strict';

const russian = {
  skip:'Перейти к содержимому',navBuild:'сборка',navWiring:'схема',navApp:'приложение',navLog:'журнал',
  eyebrow:'Стендовый эксперимент с голосовым кодингом',hero1:'Меньше печатать.',hero2:'Больше создавать.',
  intro:'Кнопка, микрофон и следующая идея. Зажмите — говорите. Отпустите — получите черновик в Claude Code или Codex. Проверьте текст и отправьте сами.',
  startBuild:'Собрать самому',viewSource:'Посмотреть исходники ↗',localTranscription:'Локальное распознавание',
  unitSub:'беспроводной пульт диктовки',simBadge:'демо',unitHold:'зажмите — говорите',
  termTitle:'claude · демо vibemic',sentLine:'черновик вставлен — проверьте его в агенте',sendBtn:'отправить',
  hintIdle:'зажмите оранжевую кнопку · пробел тоже работает',demoNote:'интерактивная симуляция — микрофон не записывается.',
  heroCaption:'Покомпонентный рендер прототипа. Для сборки используйте точную схему ниже.',stamp:'без корпуса. только провода.',
  flowHold:'01 / зажмите ptt',flowRadio:'02 / радио → usb',flowDraft:'03 / распознавание',flowSend:'04 / проверьте и отправьте',
  buildEyebrow:'01 / соберите компоненты',buildTitle:'Минимум деталей.\nМаксимум макетки.',
  buildIntro:'Две платы: передатчик с кнопкой и донгл в компьютере. Первая сборка питается по USB.',
  renderNote:'Компоненты отрисованы отдельно. Точное положение пинов указано на схеме подключения.',
  boardDesc:'nice!nano / совместимый Pro Micro SuperMini',micName:'PDM-микрофон',buttonName:'Моментальная кнопка PTT',
  buttonDesc:'Нормально разомкнутая, работает при удержании',breadDesc:'400 контактов + провода + USB-кабели с данными',
  partsFoot:'Нужны платы nRF52840 с native USB и поддерживаемым загрузчиком UF2. Классический Pro Micro на ATmega32U4 — другая плата.',
  wiringEyebrow:'02 / соедините контакты',wiringTitle:'Семь проводов до первой фразы.',openDiagram:'Открыть схему в полном размере ↗',
  pinTitle:'Подключение передатчика',pinIntro:'Сверяйте обозначения P0.xx своей платы. D1–D3 соответствуют nice!nano, вид сверху, USB вверху.',
  mountNote:'Каждый пин микрофона вставляйте в отдельный ряд breadboard. У четырёхконтактной кнопки используйте диагонально противоположные выводы. Оставьте антенну свободной.',
  tableBoard:'nRF52840',tableConnect:'Подключить к',tableButton:'Кнопка PTT → GND',sources:'Проверено по:',
  stepsEyebrow:'03 / первый запуск',stepsTitle:'От проводов\nдо промпта.',fullGuide:'Полная инструкция и диагностика ↗',
  step1Title:'Подключите передатчик',step1:'Соберите схему при отключённом питании. Донглу нужен только USB-кабель с данными для подключения к компьютеру.',
  step2Title:'Прошейте обе платы',step2:'Откройте «Платы» в VibeMic. Войдите в UF2, сохраните код радиопары и прошейте «Донгл» и «Передатчик» с одним кодом. Приложение сохранит CURRENT.UF2, если он доступен.',
  step3Title:'Проверьте звук, выберите агента',step3:'Начните с USB-проверки PDM или проверки радиозвука. Выберите PTT Dictation Mic, скачайте модель распознавания речи и откройте сессию Claude Code или Codex CLI в приложении.',
  step4Title:'Зажмите. Скажите. Отпустите. Проверьте.',step4:'Распознанный текст становится черновиком. Проверьте его перед Enter в агенте. У прототипа одна кнопка PTT; промпты автоматически не отправляются.',
  appEyebrow:'04 / приложение vibemic',appTitle:'Ваш голос.\nВаш локальный процесс.',
  appIntro:'В VibeMic можно локально распознавать речь, прошивать Vaibik, проверять аудио и запускать Claude Code или Codex во встроенном терминале.',
  appFeature1:'Русский и английский интерфейс независимо от языка диктовки',appFeature2:'Отдельный выбор микрофона для диктовки и звонков',
  appFeature3:'Черновики можно редактировать; отправляете вы',releaseLink:'Что нового и все загрузки ↗',appCaption:'VibeMic 0.1.22 в демопрофиле.',
  downloadNote:'Для актуальных сборок нужна macOS 13.3 или новее. Подробности о пакетах есть в примечаниях к релизу.',
  statusEyebrow:'05 / честный журнал стенда',statusTitle:'Основа уже работает.\nЭто всё ещё прототип.',tested:'проверено',pending:'следующее на стенде',
  statusTested:'USB Audio + HID, записанная речь через радиопару, локальное распознавание и вставка черновика во встроенный терминал.',
  statusPending:'Живой внешний PDM и физическая кнопка, надёжность на 2–3 метрах, потребление и вставка в отдельные окна приложений.',
  footer:'Публичный эксперимент с железом и софтом от nLight.'
};

const demoStrings = {
  en:{idle:'hold to talk',ready:'ready',busy:'transcribing…',dsp:'dsp',draft:'draft ready',ok:'ok',sent:'sent ↵',tx:'tx',link:'esb · link ok',
      hintIdle:'hold the orange button · space works too',hintRec:'listening… release to transcribe',hintBusy:'transcribing locally…',hintDraft:'review the draft, then send',hintSent:'inserted into the agent',
      pttAria:'Push to talk — hold to record a simulated draft',soundOn:'Mute interface sounds',soundOff:'Unmute interface sounds'},
  ru:{idle:'зажмите — говорите',ready:'готов',busy:'распознавание…',dsp:'dsp',draft:'черновик готов',ok:'ок',sent:'отправлено ↵',tx:'tx',link:'esb · связь ок',
      hintIdle:'зажмите оранжевую кнопку · пробел тоже работает',hintRec:'слушаю… отпустите для распознавания',hintBusy:'локальное распознавание…',hintDraft:'проверьте черновик и отправьте',hintSent:'вставлено в агент',
      pttAria:'Push-to-talk — удерживайте для записи демо-черновика',soundOn:'Выключить звуки интерфейса',soundOff:'Включить звуки интерфейса'}
};

const phrases = {
  en:['refactor the audio pipeline to use a ring buffer','add retries and backoff to the radio link','write a test for the PTT debounce logic','explain why the dongle enumerates as two USB devices','profile the transcription latency on battery power'],
  ru:['переведи аудиотракт на кольцевой буфер','добавь повторы и задержки в радиолинк','напиши тест для антидребезга кнопки PTT','объясни, почему донгл определяется как два USB-устройства','измерь задержку распознавания при питании от батареи']
};

const parts = [
  ['controller-render.png','nRF52840 Pro Micro style board render','Рендер платы nRF52840 формата Pro Micro'],
  ['microphone-render.png','Adafruit PDM microphone module render','Рендер PDM-модуля Adafruit'],
  ['button-render.png','Normally open momentary button render','Рендер нормально разомкнутой кнопки'],
  ['breadboard-render-v2.png','400 contact breadboard render','Рендер breadboard на 400 контактов']
];

const english = new Map([...document.querySelectorAll('[data-i18n]')].map(node => [node, node.innerHTML]));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let language = 'en';
let activePart = 0;
let swapTimer = 0;

const unit = document.getElementById('unit');
const ptt = document.getElementById('ptt');
const lcdMessage = document.getElementById('lcd-message');
const lcdStatus = document.getElementById('lcd-status');
const lcdLink = document.getElementById('lcd-link');
const lcdTimer = document.getElementById('lcd-timer');
const termHint = document.getElementById('term-hint');
const termDraft = document.getElementById('term-draft');
const termOk = document.getElementById('term-ok');
const draftText = document.getElementById('draft-text');
const sendBtn = document.getElementById('send-btn');
const soundBtn = document.getElementById('sound-toggle');

/* ---- language ---- */
function setLanguage(next) {
  language = next === 'ru' ? 'ru' : 'en';
  document.documentElement.lang = language;
  for (const [node, original] of english) {
    if (language === 'ru' && russian[node.dataset.i18n]) {
      node.replaceChildren(...russian[node.dataset.i18n].split('\n').flatMap((line, i) => i ? [document.createElement('br'), document.createTextNode(line)] : [document.createTextNode(line)]));
    } else node.innerHTML = original;
  }
  document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === language)));
  document.getElementById('readme-link').href = language === 'ru' ? 'https://github.com/nLight/Vaibik/blob/main/README.ru.md' : 'https://github.com/nLight/Vaibik#readme';
  document.title = language === 'ru' ? 'Vaibik — голосом к следующему коммиту' : 'Vaibik — speak your next commit';
  document.querySelector('.main-nav').setAttribute('aria-label', language === 'ru' ? 'Навигация' : 'Main navigation');
  document.querySelector('.languages').setAttribute('aria-label', language === 'ru' ? 'Язык' : 'Language');
  document.querySelector('.parts-list').setAttribute('aria-label', language === 'ru' ? 'Выбор компонента' : 'Component selector');
  document.querySelectorAll('.brand').forEach(b => b.setAttribute('aria-label', language === 'ru' ? 'Vaibik — в начало' : 'Vaibik home'));
  document.querySelector('.wiring-figure a').setAttribute('aria-label', language === 'ru' ? 'Открыть схему в полном размере' : 'Open full-size wiring reference');
  document.querySelector('.hero-image').alt = language === 'ru' ? 'Иллюстрация макетного передатчика с микрофоном и кнопкой PTT и отдельного USB-донгла' : 'Illustrated bare breadboard transmitter with microphone and PTT button, and a separate USB receiver';
  document.querySelector('.app-shot img').alt = language === 'ru' ? 'Английский интерфейс приложения VibeMic, демопрофиль' : 'English VibeMic companion app overview, demo profile';
  ptt.setAttribute('aria-label', demoStrings[language].pttAria);
  soundBtn.setAttribute('aria-label', soundOn ? demoStrings[language].soundOn : demoStrings[language].soundOff);
  applyDemoStrings();
  selectPart(activePart);
  try { localStorage.setItem('vaibik-language', language); } catch {}
}

/* ---- parts selector ---- */
function selectPart(index) {
  activePart = index;
  const [file, en, ru] = parts[index];
  const img = document.getElementById('part-image');
  document.getElementById('part-number').textContent = String(index + 1).padStart(2, '0') + ' / 04';
  document.querySelectorAll('[data-part]').forEach(button => {
    const active = Number(button.dataset.part) === index;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  clearTimeout(swapTimer);
  img.classList.add('swap');
  swapTimer = setTimeout(() => {
    img.src = 'assets/' + file;
    img.alt = language === 'ru' ? ru : en;
    img.classList.remove('swap');
  }, reduced ? 0 : 160);
}

/* ---- sound ---- */
let soundOn = true;
try { soundOn = localStorage.getItem('vaibik-sound') !== 'off'; } catch {}
let audioCtx = null;
function ensureAudio() {
  if (!soundOn) return;
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; } }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function blip(freq, dur, type, gain) {
  if (!soundOn || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type || 'square';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain || 0.04, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}
function renderSoundButton() {
  soundBtn.setAttribute('aria-pressed', String(soundOn));
  soundBtn.querySelector('.led').classList.toggle('on', soundOn);
  soundBtn.setAttribute('aria-label', soundOn ? demoStrings[language].soundOn : demoStrings[language].soundOff);
}
soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem('vaibik-sound', soundOn ? 'on' : 'off'); } catch {}
  renderSoundButton();
  if (soundOn) { ensureAudio(); blip(1200, 0.06, 'sine', 0.05); }
});

/* ---- PTT demo state machine ---- */
let state = 'idle';
let recStart = 0;
let phraseIndex = 0;
let currentPhrase = '';
let busyTimer = 0, typeTimer = 0, sentTimer = 0;

function applyDemoStrings() {
  const s = demoStrings[language];
  lcdLink.textContent = s.link;
  if (state === 'idle') { lcdMessage.textContent = s.idle; lcdStatus.textContent = s.ready; termHint.textContent = s.hintIdle; }
  else if (state === 'rec') { lcdStatus.textContent = '● rec'; termHint.textContent = s.hintRec; }
  else if (state === 'busy') { lcdMessage.textContent = s.busy; lcdStatus.textContent = s.dsp; termHint.textContent = s.hintBusy; }
  else if (state === 'draft') { lcdMessage.textContent = s.draft; lcdStatus.textContent = s.ok; termHint.textContent = s.hintDraft; }
  else if (state === 'sent') { lcdMessage.textContent = s.sent; lcdStatus.textContent = s.tx; termHint.textContent = s.hintSent; }
}
function setState(next) {
  state = next;
  unit.dataset.state = next;
  ptt.setAttribute('aria-pressed', String(next === 'rec'));
  applyDemoStrings();
}
function startRec() {
  if (state !== 'idle') return;
  ensureAudio();
  blip(1600, 0.05, 'square', 0.04);
  const list = phrases[language];
  currentPhrase = list[phraseIndex++ % list.length];
  recStart = performance.now();
  setState('rec');
  startWave();
}
function endRec() {
  if (state !== 'rec') return;
  stopWave();
  blip(1100, 0.05, 'square', 0.035);
  setState('busy');
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => { setState('draft'); showDraft(); }, reduced ? 150 : 850);
}
function showDraft() {
  termOk.hidden = true;
  termDraft.hidden = false;
  draftText.textContent = '';
  sendBtn.disabled = false;
  blip(880, 0.07, 'sine', 0.05);
  setTimeout(() => blip(1320, 0.09, 'sine', 0.05), 80);
  clearInterval(typeTimer);
  if (reduced) { draftText.textContent = currentPhrase; return; }
  let i = 0;
  typeTimer = setInterval(() => {
    i += 1;
    draftText.textContent = currentPhrase.slice(0, i);
    if (i >= currentPhrase.length) clearInterval(typeTimer);
  }, 22);
}
function send() {
  if (state !== 'draft') return;
  clearInterval(typeTimer);
  draftText.textContent = currentPhrase;
  termDraft.hidden = true;
  termOk.hidden = false;
  sendBtn.disabled = true;
  blip(660, 0.09, 'sine', 0.05);
  setState('sent');
  clearTimeout(sentTimer);
  sentTimer = setTimeout(resetDemo, reduced ? 500 : 1700);
}
function resetDemo() {
  clearTimeout(busyTimer); clearInterval(typeTimer); clearTimeout(sentTimer);
  termDraft.hidden = true;
  termOk.hidden = true;
  draftText.textContent = '';
  sendBtn.disabled = true;
  setState('idle');
}

ptt.addEventListener('pointerdown', e => { e.preventDefault(); try { ptt.setPointerCapture(e.pointerId); } catch {} startRec(); });
ptt.addEventListener('pointerup', endRec);
ptt.addEventListener('pointercancel', endRec);
ptt.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startRec(); } });
ptt.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endRec(); } });
window.addEventListener('blur', () => { if (state === 'rec') endRec(); });
sendBtn.addEventListener('click', send);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && state === 'draft' && (e.target === document.body || e.target === ptt)) { e.preventDefault(); send(); }
});

/* ---- waveform ---- */
const wave = document.getElementById('wave');
const wctx = wave.getContext('2d');
const BARS = 64;
const waveVals = new Float32Array(BARS);
const waveTargets = new Float32Array(BARS);
let waveW = 0, waveH = 0, rafId = 0, lastTarget = 0;
function sizeWave() {
  const rect = wave.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  wave.width = Math.round(rect.width * dpr);
  wave.height = Math.round(rect.height * dpr);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveW = rect.width; waveH = rect.height;
}
function drawWave(now) {
  if (now - lastTarget > 70) {
    lastTarget = now;
    const burst = Math.random() < 0.72 ? 1 : 0.22;
    for (let i = 0; i < BARS; i++) {
      waveTargets[i] = Math.max(0.05, burst * (0.25 + 0.75 * Math.random()) * (0.55 + 0.45 * Math.sin(i * 0.35 + now * 0.004)));
    }
  }
  wctx.clearRect(0, 0, waveW, waveH);
  const bw = waveW / BARS;
  wctx.fillStyle = '#ff4d00';
  for (let i = 0; i < BARS; i++) {
    waveVals[i] += (waveTargets[i] - waveVals[i]) * 0.35;
    const h = Math.max(2, waveVals[i] * waveH * 0.92);
    wctx.fillRect(i * bw + bw * 0.2, (waveH - h) / 2, bw * 0.6, h);
  }
  const elapsed = (now - recStart) / 1000;
  const m = Math.floor(elapsed / 60), s = Math.floor(elapsed % 60), d = Math.floor((elapsed * 10) % 10);
  lcdTimer.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + d;
  rafId = requestAnimationFrame(drawWave);
}
function startWave() {
  sizeWave();
  if (rafId) return;
  lastTarget = 0;
  rafId = requestAnimationFrame(drawWave);
}
function stopWave() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}
if (window.ResizeObserver) new ResizeObserver(sizeWave).observe(wave);
else window.addEventListener('resize', sizeWave);

/* ---- reveals + nav + header ---- */
const revealEls = [...document.querySelectorAll('.reveal')];
let revealPending = revealEls.slice();
function runReveal() {
  if (!revealPending.length) return;
  const limit = window.innerHeight * 0.9;
  revealPending = revealPending.filter(el => {
    if (el.getBoundingClientRect().top < limit) { el.classList.add('in'); return false; }
    return true;
  });
}
if (reduced) {
  revealEls.forEach(el => el.classList.add('in'));
  revealPending = [];
} else {
  let revealTick = false;
  const queueReveal = () => { if (!revealTick) { revealTick = true; requestAnimationFrame(() => { revealTick = false; runReveal(); }); } };
  window.addEventListener('scroll', queueReveal, { passive: true });
  window.addEventListener('resize', queueReveal);
  window.addEventListener('load', queueReveal);
  runReveal();
}

const navLinks = [...document.querySelectorAll('.main-nav a')];
const spySections = ['build', 'wiring', 'software', 'log'].map(id => ({ id, el: document.getElementById(id) })).filter(s => s.el);
let spyTick = false;
function updateSpy() {
  spyTick = false;
  const probe = window.scrollY + window.innerHeight * 0.4;
  let current = spySections[0].id;
  for (const s of spySections) {
    if (s.el.getBoundingClientRect().top + window.scrollY <= probe) current = s.id;
  }
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) current = spySections[spySections.length - 1].id;
  navLinks.forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + current ? 'true' : 'false'));
}
function queueSpy() { if (!spyTick) { spyTick = true; requestAnimationFrame(updateSpy); } }
window.addEventListener('scroll', queueSpy, { passive: true });
window.addEventListener('resize', queueSpy);
updateSpy();

const header = document.querySelector('.header');
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ---- init ---- */
parts.forEach(([file]) => { const im = new Image(); im.src = 'assets/' + file; });
document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => setLanguage(b.dataset.lang)));
document.querySelectorAll('[data-part]').forEach(b => b.addEventListener('click', () => selectPart(Number(b.dataset.part))));
renderSoundButton();
try { setLanguage(localStorage.getItem('vaibik-language') || 'en'); } catch { setLanguage('en'); }
setState('idle');
sizeWave();
window.__vaibikReady = true;
