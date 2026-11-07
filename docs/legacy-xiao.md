# VibeMic на XIAO

Беспроводной PTT-микрофон для Claude Code и Codex на Mac. Зажмите кнопку, произнесите задачу и отпустите. VibeMic Bridge локально распознаёт речь и вставляет черновик в открытое поле ввода. Вы можете поправить текст и отправить его обычной клавишей приложения.

Донгл предоставляет USB-микрофон **PTT Dictation Mic** и HID-клавиатуру. **⌃⌥⌘F13** удерживается на время записи и отпускается после передачи аудиохвоста. Обе прошивки и диагностические образы собраны на **nRF Connect SDK v3.4.2**. Сквозная проверка на физических платах, измерение дальности и тока ещё впереди. [Архитектура и ссылки на официальные примеры](engineering.md).

| Роль | Плата | Zephyr board target |
| --- | --- | --- |
| Передатчик | Seeed Studio XIAO nRF52840 **Sense**, обычная версия | `xiao_ble/nrf52840/sense` |
| USB-донгл | Seeed Studio XIAO nRF52840, обычная версия без Sense | `xiao_ble/nrf52840` |

Подключите нормально разомкнутую кнопку передатчика между **D0 (P0.02)** и **GND**. В прошивке есть внутренняя подтяжка и подавление дребезга. При удержании горит штатный красный LED. Первые проверки можно делать с передатчиком, запитанным через USB. Для автономной проверки подключите одноэлементный LiPo к площадкам BAT с полярностью по [схеме своей ревизии Seeed](https://wiki.seeedstudio.com/XIAO_BLE/#resources). Для донгла нужна только плата и USB-C кабель с линиями данных.

## Сборка

Установите [nRF Util](https://www.nordicsemi.com/Products/Development-tools/nRF-Util). Из папки VibeMic:

```sh
VIBEMIC="$(pwd)"
export VIBEMIC
nrfutil install sdk-manager
nrfutil sdk-manager install v3.4.2
nrfutil sdk-manager toolchain launch --ncs-version v3.4.2 --shell
```

В открывшейся оболочке перейдите в workspace SDK, путь к которому показывает `nrfutil sdk-manager list` (при стандартной установке — `/opt/nordic/ncs/v3.4.2`). `west topdir` должен вернуть корень этого SDK.

```sh
cd /opt/nordic/ncs/v3.4.2
west build --no-sysbuild -p always -b xiao_ble/nrf52840/sense \
  -d "$VIBEMIC/build/tx" "$VIBEMIC/firmware/transmitter"
west build --no-sysbuild -p always -b xiao_ble/nrf52840 \
  -d "$VIBEMIC/build/rx" "$VIBEMIC/firmware/receiver"
```

Для отдельной установки Zephyr SDK проект также собран с **Zephyr SDK 1.0.1 / ARM GCC 14.3.0**, используя [west manifest Nordic v3.4.2](https://github.com/nrfconnect/sdk-nrf/blob/v3.4.2/west.yml), который подключает Zephyr `ncs-v3.4.2` (4.4.2). Собирайте из workspace NCS: ESB берётся из Nordic SDK.

## Прошивка по USB

1. Подключите одну плату к Mac кабелем данных. Дважды быстро нажмите Reset на плате. Появится диск **XIAO-SENSE** (TX) или **XIAO-BOOT** (RX). Сверьте имя диска и платы.
2. Скопируйте на него соответствующий `zephyr.uf2`. Плата перезагрузится, диск исчезнет.
3. Повторите для второй платы. После прошивки донгл подключается как USB Audio + HID, передатчик в обычном режиме использует USB только для питания и входа в загрузчик.

```sh
cp "$VIBEMIC/build/tx/zephyr/zephyr.uf2" /Volumes/XIAO-SENSE/
cp "$VIBEMIC/build/rx/zephyr/zephyr.uf2" /Volumes/XIAO-BOOT/
```

Сборки используют штатную карту памяти XIAO с началом приложения `0x27000`. Если загрузочный диск не появляется, проверьте кабель и двойной Reset. При заменённом или стёртом загрузчике восстановите заводской загрузчик по [инструкции Seeed](https://wiki.seeedstudio.com/XIAO_BLE/#power-consumption-verification); не стирайте всю флеш-память ради обычного обновления.

## Проверка по частям

**1. Встроенный микрофон.** Соберите вариант PDM Probe, прошейте передатчик и найдите его порт `/dev/cu.usbmodem*`. Команда ниже записывает три секунды в WAV и показывает пиковый уровень и число отсчётов на пределе диапазона. Повторите для речи и шёпота на 10, 20 и 40 см. Проверьте разборчивость, шум и щелчок кнопки; усиление меняйте по результату.

```sh
west build --no-sysbuild -p always -b xiao_ble/nrf52840/sense \
  -d "$VIBEMIC/build/tx-probe" "$VIBEMIC/firmware/transmitter" -- \
  -DCONF_FILE="$VIBEMIC/firmware/transmitter/mic-probe.conf" \
  -DEXTRA_DTC_OVERLAY_FILE="$VIBEMIC/firmware/transmitter/mic-probe.overlay"
```

В обычной оболочке Mac после прошивки `build/tx-probe/zephyr/zephyr.uf2`:

```sh
cd "$VIBEMIC"
python3 -m venv .venv
.venv/bin/pip install pyserial
ls /dev/cu.usbmodem*
.venv/bin/python tools/capture_mic.py /dev/cu.usbmodem123 mic-20cm.wav
afplay mic-20cm.wav
```

**2. USB Audio без радиоканала.** Соберите и прошейте `build/rx-tone/zephyr/zephyr.uf2`. В [Audio MIDI Setup](https://support.apple.com/en-lamr/guide/audio-midi-setup/ams59f301fda/mac) выберите **PTT Dictation Mic** и проверьте формат: **1 канал, 16 000 Гц, 16 бит**. В QuickTime Player → New Audio Recording выберите этот вход и запишите тон 1 кГц. Этот режим не посылает нажатий.

```sh
west build --no-sysbuild -p always -b xiao_ble/nrf52840 \
  -d "$VIBEMIC/build/rx-tone" "$VIBEMIC/firmware/receiver" -- \
  -DEXTRA_CONF_FILE="$VIBEMIC/firmware/receiver/tone.conf"
```

Если версия macOS или приложение не принимает 16 кГц, соберите вариант с USB **48 кГц**. По радио и с PDM всё равно идёт 16 кГц: донгл увеличивает частоту перед USB. Эту же накладку можно добавить к сборке с тоном.

```sh
west build --no-sysbuild -p always -b xiao_ble/nrf52840 \
  -d "$VIBEMIC/build/rx48" "$VIBEMIC/firmware/receiver" -- \
  -DEXTRA_DTC_OVERLAY_FILE="$VIBEMIC/firmware/receiver/usb48.overlay"
```

**3. Радио и HID.** Верните рабочие UF2 на обе платы. Запишите QuickTime с уже открытым входом донгла: до нажатия должна идти тишина, при удержании — голос, после отпускания — аудиохвост и снова тишина. Проверьте HID-интерфейс командой:

```sh
hidutil list --matching '{"VendorID":4617,"ProductID":1}'
```

Для диагностики радио подключите USB–UART адаптер **3,3 В**: `D6/TX → RX`, `GND → GND`, питание плат отдельно. Откройте порт на **115200 8N1**. После записи TX выводит успешные ACK, исчерпанные попытки, число повторов, среднее и максимальное время до ACK; отдельно пишет о переполнении очереди. Это время транзакции с ответом и обработкой прошивкой, а не задержка диктовки. RX сообщает причину завершения, сколько отсчётов заменил тишиной, сколько пакетов отбросил и сколько USB-кадров не смог поставить в очередь. Повторите тест вблизи, на 2–3 м и при активном трафике Wi-Fi 2,4 ГГц. Слушайте запись и сравнивайте счётчики.

**4. Сквозной тест Claude Code и Codex.** Закройте QuickTime и запустите [VibeMic Bridge](#vibemic-bridge-на-macos), чтобы проверить открытие микрофона по нажатию. Системный вход и входы Zoom/Meet оставьте на другом микрофоне.

- Установите курсор в поле ввода открытого диалога. Начните фразу одновременно с нажатием, произнесите последнее слово прямо перед отпусканием. Проверьте оба слова в черновике и отправьте его обычной клавишей приложения. Повторите в обоих приложениях и обеих CLI.
- Повторите с коротким и длинным удержанием, а также после периода простоя. Для оценки задержки снимите кнопку и экран одним видео; для оценки обрезки сравните исходную фразу с аудио записи.
- Смените чат, окно или панель, пока распознаётся фраза. Проверьте, что новый адресат остался без черновика.
- Выключите передатчик во время удержания. Сочетание должно отпуститься по тайм-ауту. Включите передатчик и нажмите заново. Повторите после переподключения донгла и перезагрузки Mac. Проверьте входы Zoom и Meet.

**5. Энергия.** После подтверждения акустики измерьте ток со стороны батареи без USB: ожидание с активным PDM, передача с LED и отдельная сборка с отключёнными PDM/радио для сравнения. Deep sleep пока не реализован: без работающего микрофона нельзя получить 120 мс звука до нажатия. Автономность выводите из измерений и доли времени записи.

Проверки кодека пакетов и буфера на компьютере: `./tools/test-host.sh`.

## VibeMic Bridge на macOS

Соберите мост через Command Line Tools for Xcode и установите локальный Whisper. `tmux` нужен для режима CLI. При первой загрузке модели Whisper скачивает веса. После этого распознавание выполняется на Mac. [Документация Whisper](https://github.com/openai/whisper#setup).

```sh
brew install ffmpeg tmux python@3.12
python3.12 -m venv .venv
.venv/bin/python -m pip install openai-whisper
.venv/bin/python -c 'import whisper; whisper.load_model("base", device="cpu")'
export PATH="$PWD/.venv/bin:$PATH"
./script/build_and_run.sh --bridge --build-only
./build/macos/vibemic-bridge
```

При первом запуске macOS может попросить доступ к микрофону и мониторингу ввода. Разрешите их для VibeMic или приложения терминала, которое указала macOS. Для вставки откройте **System Settings → Privacy & Security → Accessibility** и разрешите доступ для моста или его терминала. После изменения разрешений запустите мост заново. Остановить мост можно через `Ctrl+C` в его терминале.

- **Claude Desktop и Codex на Mac.** Откройте текущий диалог, поставьте курсор в поле ввода и удерживайте PTT. Мост сверяет окно и поле перед вставкой. При необходимости он выполняет обычную вставку и восстанавливает предыдущий буфер обмена, если его не меняли.
- **Claude Code CLI и Codex CLI.** Откройте их в отдельных окнах одной сессии `tmux` на сервере `vibemic`. Держите к серверу подключённым один клиент. Переключайтесь между окнами обычными клавишами tmux. Мост вставляет текст только в активную панель, где запущен `claude` или `codex`.

```sh
# Выполните в отдельной вкладке терминала из папки нужного проекта.
tmux -L vibemic new-session -d -s vibemic -n codex codex
tmux -L vibemic new-window -t vibemic -n claude claude
tmux -L vibemic set-option -g focus-events on
tmux -L vibemic attach-session -t vibemic
```

Диагностика моста через `--list-inputs`, `--check-tmux` и `--transcribe файл.wav`. Если подключено несколько одинаковых микрофонов, укажите идентификатор из `--list-inputs` через `VIBEMIC_INPUT`. Распознавание по умолчанию определяет язык по аудио. Для русского можно запустить мост с `VIBEMIC_LANGUAGE=ru`.

Сборка моста нацелена на macOS 12+, а локальная проверка прошла на Apple Silicon. Версии Claude Desktop, Codex и зависимостей Whisper имеют собственные системные требования.
