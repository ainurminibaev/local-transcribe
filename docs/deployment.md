# Самостоятельная установка local-transcribe

Источник всего решения — этот Git-репозиторий. `bb-config` содержит только резервную копию интеграции BB; для новой установки он не нужен. Код распознавания, инструкции, загрузчик видео, PDF-шаблоны и плагин лежат здесь.

## Исполнитель: Mac или Linux

Нужны Python >= 3.10, ffmpeg, Git. На macOS для PDF: `brew install ffmpeg pandoc pango`; на Debian/Ubuntu: `apt install ffmpeg pandoc libpango-1.0-0 libpangoft2-1.0-0`.

```sh
git clone https://github.com/ainurminibaev/local-transcribe.git
cd local-transcribe
python3 scripts/setup_worker.py --download-model
```

Репозиторий приватный: доступ к GitHub нужен при клонировании. Для самой обработки токен GitHub не используется. Распознавание использует локальные модели; `--download-model` загружает публичные веса GigaAM, не передавая записи. Если модель уже есть в обычном кэше HuggingFace, повторного скачивания нет. Эта же команда скачивает веса ModelScope VAD/спикеров. Обработка читает локальные пути и не обращается к хабу за проверкой доступа. Для полностью автономной машины подготовьте их заранее, выполнив пробный запуск на тестовом аудио.

На Linux без CUDA используйте `python3 scripts/setup_worker.py --cpu --download-model`, чтобы установить CPU-вариант PyTorch.

Установщик создаёт `.venv`, не меняет системный Python и не устанавливает системные пакеты. Посмотреть команды без установки: `python3 scripts/setup_worker.py --download-model --dry-run`. Проверка: `.venv/bin/python probe_service.py`. Прямой запуск: `.venv/bin/python diarize_ms.py recording.m4a --out transcript.txt`.

На Apple Silicon ASR GGUF использует Metal, speaker embeddings — MPS. На других машинах выбирается доступная CUDA или CPU. VAD/кластеризация могут работать на CPU. Готовность и фактическое устройство сообщает probe/API.

Чтобы BB обнаружил исполнителя, добавьте checkout как source проекта с тем же именем:

```sh
bb project source add <project-id> --machine <worker-machine-id> --path /absolute/path/local-transcribe
```

Список машин: `bb machine list --json`; проекты: `bb project list --json`. Если проекта ещё нет: `bb project create --name local-transcribe --root /absolute/path/local-transcribe --machine <worker-machine-id>`.

## Сервер BB

Checkout на сервере может использоваться только для разработки/маршрутизации. Распознавание и тяжёлые Python-зависимости на нём не обязательны.

```sh
cd local-transcribe/bb-plugin
bb plugin types .
npm ci --ignore-scripts
bb plugin build .
bb plugin install . --yes
```

Один раз установленный плагин предоставляет навыки и инструменты всем провайдерам, проектам и подключённым машинам этого BB. В других инсталляциях BB установите плагин там же. Новые/пересозданные сессии получают актуальный каталог навыков; уже работающий процесс может сохранять прежний каталог.

API: `bb plugin rpc list local-transcribe --json`, список сервисов: `bb plugin rpc call local-transcribe services --json`. Для вызовов `submit/status/copy` используйте `--input-file request.json`; полная схема доступна через `bb plugin rpc inspect local-transcribe <method> --json`.

Политика по умолчанию: Mac → self (машина исходного треда, если она готова) → available (остальные готовые сервисы, каждый один раз). Вызов может передать свой список запасных или `fallback: []`. Все серверы выбираются из обнаруженных source проекта; облачный ASR в этот список сам не добавляется. Чтобы использовать другое имя проекта, задайте `bb plugin config local-transcribe set projectName <name>`.

## Обновление и проверки

```sh
git pull --ff-only
python3 scripts/sync_bb_skill.py --check
python3 -m unittest discover -p 'test_*.py' -v
cd bb-plugin
npm ci --ignore-scripts
node --test policy.test.mjs service.test.mjs host.test.mjs
bb plugin build .
bb plugin reload local-transcribe
```

После изменения `docs/транскрибация-и-итоги.md` или PDF-шаблонов выполните `python3 scripts/sync_bb_skill.py` и включите обновлённые ресурсы навыка в тот же коммит.

Проверяйте сквозной сценарий синтетическим аудио: передача между машинами → вызов с неготовым основным и готовым запасным → транскрипт со спикерами → возврат → Markdown/PDF. Отдельно проверяйте, что существующий выходной файл не заменяется и что потеря связи с запущенным терминалом не приводит к второму запуску. Ошибка возврата транскрипта не запускает распознавание повторно.


Для Linux x86_64 / Python 3.12 CPU-установка использует проверенный `requirements-cpu-py312.lock`; другие конфигурации используют базовые зависимости. ModelScope runtime скачивается с официальных публичных адресов по `models-manifest.json`, с закреплёнными SHA-256 и revision для VAD. Веса не входят в Git.
