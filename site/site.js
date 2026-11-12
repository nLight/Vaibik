'use strict';
const russian = {
 stamp:'БЕЗ КОРПУСА. ТОЛЬКО ПРОВОДА.',skip:'Перейти к содержимому',navBuild:'Сборка',navApp:'Приложение',eyebrow:'Стендовый эксперимент с голосовым кодингом',hero1:'Меньше печатать.',hero2:'Больше создавать.',intro:'Кнопка, микрофон и следующая идея. Зажмите — говорите. Отпустите — получите черновик в Claude Code или Codex. Проверьте текст и отправьте сами.',startBuild:'Собрать самому ↘',viewSource:'Посмотреть исходники ↗',localTranscription:'Локальное распознавание',heroCaption:'Покомпонентный рендер прототипа. Для сборки используйте точную схему ниже.',flowHold:'01 / ЗАЖМИТЕ PTT',flowRadio:'02 / РАДИО → USB',flowDraft:'03 / РАСПОЗНАВАНИЕ',flowSend:'04 / ПРОВЕРЬТЕ И ОТПРАВЬТЕ',buildEyebrow:'01 / Соберите компоненты',buildTitle:'Минимум деталей.\nМаксимум макетки.',buildIntro:'Две платы: передатчик с кнопкой и донгл в компьютере. Первая сборка питается по USB.',renderNote:'Компоненты отрисованы отдельно. Точное положение пинов указано на схеме подключения.',boardDesc:'nice!nano / совместимый Pro Micro SuperMini',micName:'PDM-микрофон',buttonName:'Моментальная кнопка PTT',buttonDesc:'Нормально разомкнутая, работает при удержании',breadDesc:'400 контактов + провода + USB-кабели с данными',partsFoot:'Нужны платы nRF52840 с native USB и поддерживаемым загрузчиком UF2. Классический Pro Micro на ATmega32U4 — другая плата.',wiringEyebrow:'02 / Соедините контакты',wiringTitle:'Семь проводов до первой фразы.',openDiagram:'Открыть схему в полном размере ↗',pinTitle:'Подключение передатчика',pinIntro:'Сверяйте обозначения P0.xx своей платы. D1–D3 соответствуют nice!nano, вид сверху, USB вверху.',mountNote:'Каждый пин микрофона вставляйте в отдельный ряд breadboard. У четырёхконтактной кнопки используйте диагонально противоположные выводы. Оставьте антенну свободной.',tableBoard:'nRF52840',tableConnect:'Подключить к',tableButton:'Кнопка PTT → GND',sources:'Проверено по:',stepsEyebrow:'03 / Первый запуск',stepsTitle:'От проводов\nдо промпта.',fullGuide:'Полная инструкция и диагностика ↗',step1Title:'Подключите передатчик',step1:'Соберите схему при отключённом питании. Донглу нужен только USB-кабель с данными для подключения к компьютеру.',step2Title:'Прошейте обе платы',step2:'Откройте «Платы» в VibeMic. Войдите в UF2, сохраните код радиопары и прошейте «Донгл» и «Передатчик» с одним кодом. Приложение сохранит CURRENT.UF2, если он доступен.',step3Title:'Проверьте звук, выберите агента',step3:'Начните с USB-проверки PDM или проверки радиозвука. Выберите PTT Dictation Mic, скачайте модель распознавания речи и откройте сессию Claude Code или Codex CLI в приложении.',step4Title:'Зажмите. Скажите. Отпустите. Проверьте.',step4:'Распознанный текст становится черновиком. Проверьте его перед Enter в агенте. У прототипа одна кнопка PTT; промпты автоматически не отправляются.',appEyebrow:'04 / Приложение VibeMic',appTitle:'Ваш голос.\nВаш локальный процесс.',appIntro:'В VibeMic можно локально распознавать речь, прошивать Vaibik, проверять аудио и запускать Claude Code или Codex во встроенном терминале.',appFeature1:'Русский и английский интерфейс независимо от языка диктовки',appFeature2:'Отдельный выбор микрофона для диктовки и звонков',appFeature3:'Черновики можно редактировать; отправляете вы',releaseLink:'Что нового и все загрузки ↗',appCaption:'VibeMic 0.1.22 в демопрофиле.',downloadNote:'Для актуальных сборок нужна macOS 13.3 или новее. Подробности о пакетах есть в примечаниях к релизу.',statusEyebrow:'Честный журнал стенда',statusTitle:'Основа уже работает.\nЭто всё ещё прототип.',tested:'ПРОВЕРЕНО',pending:'СЛЕДУЮЩЕЕ НА СТЕНДЕ',statusTested:'USB Audio + HID, записанная речь через радиопару, локальное распознавание и вставка черновика во встроенный терминал.',statusPending:'Живой внешний PDM и физическая кнопка, надёжность на 2–3 метрах, потребление и вставка в отдельные окна приложений.',footer:'Публичный эксперимент с железом и софтом от nLight.'
};
const english = new Map([...document.querySelectorAll('[data-i18n]')].map(node => [node, node.innerHTML]));
let language = 'en';
const parts = [
 ['controller-render.png','nRF52840 Pro Micro style board render','Рендер платы nRF52840 формата Pro Micro'],
 ['microphone-render.png','Adafruit PDM microphone module render','Рендер PDM-модуля Adafruit'],
 ['button-render.png','Normally open momentary button render','Рендер нормально разомкнутой кнопки'],
 ['breadboard-render-v2.png','400 contact breadboard render','Рендер breadboard на 400 контактов']
];
let activePart = 0;
function selectPart(index) {
 activePart=index;
 const [file,en,ru]=parts[index];
 document.querySelector('#part-image').src='assets/'+file;
 document.querySelector('#part-image').alt=language==='ru'?ru:en;
 document.querySelector('#part-number').textContent=String(index+1).padStart(2,'0')+' / 04';
 document.querySelectorAll('[data-part]').forEach(button=>{
  const active=Number(button.dataset.part)===index;
  button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
 });
}
function setLanguage(next) {
 language=next==='ru'?'ru':'en';document.documentElement.lang=language;
 for(const [node,original] of english){
  if(language==='ru'&&russian[node.dataset.i18n]){
   node.replaceChildren(...russian[node.dataset.i18n].split('\n').flatMap((line,i)=>i?[document.createElement('br'),document.createTextNode(line)]:[document.createTextNode(line)]));
  }else node.innerHTML=original;
 }
 document.querySelectorAll('[data-lang]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.lang===language)));
 document.querySelector('#readme-link').href=language==='ru'?'https://github.com/nLight/Vaibik/blob/main/README.ru.md':'https://github.com/nLight/Vaibik#readme';
 document.title=language==='ru'?'Vaibik — голосом к следующему коммиту':'Vaibik — speak your next commit';
 document.querySelector('nav').setAttribute('aria-label',language==='ru'?'Навигация':'Main navigation');
 document.querySelector('.languages').setAttribute('aria-label',language==='ru'?'Язык':'Language');
 document.querySelector('.parts-list').setAttribute('aria-label',language==='ru'?'Выбор компонента':'Component selector');
 document.querySelector('.brand').setAttribute('aria-label',language==='ru'?'Vaibik — в начало':'Vaibik home');
 document.querySelector('.wiring-figure a').setAttribute('aria-label',language==='ru'?'Открыть схему в полном размере':'Open full-size wiring reference');
 document.querySelector('.hero-image').alt=language==='ru'?'Иллюстрация макетного передатчика с микрофоном и кнопкой PTT и отдельного USB-донгла':'Illustrated bare breadboard transmitter with microphone and PTT button, and a separate USB receiver';
 document.querySelector('.app-shot img').alt=language==='ru'?'Английский интерфейс приложения VibeMic, демопрофиль':'English VibeMic companion app overview, demo profile';
 selectPart(activePart);
 try{localStorage.setItem('vaibik-language',language);}catch{}
}
document.querySelectorAll('[data-lang]').forEach(button=>button.addEventListener('click',()=>setLanguage(button.dataset.lang)));
document.querySelectorAll('[data-part]').forEach(button=>button.addEventListener('click',()=>selectPart(Number(button.dataset.part))));
try{setLanguage(localStorage.getItem('vaibik-language')||'en');}catch{setLanguage('en');}
