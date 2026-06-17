# Стек локальной транскрибации со спикерами

Полностью **локальный** конвейер: речь → текст (русский) + разметка «кто говорит».
Без облака, **без токенов HuggingFace**. Каждый запуск — одноразовый процесс
(загрузил модели в RAM → отработал → вышел → ОС освободила память). **Handy не
трогаем** — только читаем её файлы моделей.

## Архитектура

```
аудио/видео ──ffmpeg──► wav 16k mono
                         │
            ┌────────────┴─────────────┐
            ▼                          ▼
   ТЕКСТ (ASR)                 СПИКЕРЫ (диаризация)
   GigaAM v3 (CTC, onnx)       ModelScope 3D-Speaker:
   из Handy                      FSMN VAD → CAM++ эмбеддинги → кластеризация
            │                          │
            └──────── склейка по таймкодам ────────►  Speaker N [mm:ss]: текст
```

- **Текст:** GigaAM v3 (e2e CTC) — лучшее качество для русского. Fallback: GigaAM → Whisper medium (whisper.cpp) → Rev.ai (через MCP).
- **Спикеры:** ModelScope `iic/speech_campplus_speaker-diarization_common` (PyTorch, считает на MPS / GPU Mac). Модели тянутся с ModelScope в `~/.cache/modelscope`.

## Файлы в `.transcribe/`

| Файл | Назначение |
|---|---|
| `diarize_ms.py` | **ГЛАВНЫЙ.** Текст (GigaAM) + спикеры (ModelScope). Дефолт для всего. |
| `transcribe.py` | Только текст, без спикеров (быстро, ~70 с). Если разметка не нужна. |
| `diarize.py` | GigaAM-функции + onnx-диаризация на sherpa-onnx (запасной путь без torch; качество ниже). `diarize_ms.py` переиспользует отсюда GigaAM. |
| `config.json` | Пути к моделям Handy, порядок движков, размер чанка. |
| `diar_models/` | onnx-модели для sherpa-варианта (pyannote-сегментация + эмбеддинги). |

## Запуск

```bash
# со спикерами (дефолт, ~4 мин на 40-мин запись)
python3 ".transcribe/diarize_ms.py" "<файл>" --out "<папка>/transcript.txt"

# без спикеров (быстро, ~70 с)
python3 ".transcribe/transcribe.py" "<файл>" --out "<папка>/transcript.txt"
```
Формат вывода со спикерами: `Speaker N [mm:ss]: текст`.

## Модели

**GigaAM (Handy, читаем, не трогаем):**
`~/Library/Application Support/com.pais.handy/models/giga-am-v3-int8/model.int8.onnx` (+ `vocab.txt`)
Whisper-fallback: `.../whisper-medium-q4_1.bin`.

**Диаризация (ModelScope, авто-загрузка в `~/.cache/modelscope`):**
`iic/speech_campplus_speaker-diarization_common` (тянет за собой CAM++ SV, FSMN VAD, SCL-ресегментацию).

## GigaAM — точный препроцессинг (реверс из крейта `transcribe-rs`, движок Handy)

Критично воспроизвести 1-в-1, иначе текст — мусор:
- вход модели: `features [1, 64, T]` + `feature_lengths`; выход: `log_probs [1, T, 257]` (CTC, blank=256).
- мел-спектр: `n_fft=320` (FFT ровно 320, **без округления**), `hop=160`, `win=320`, **center=False**.
- окно Ханна **периодическое**: `0.5*(1-cos(2πi/320))`.
- мел-фильтрбанк: HTK-шкала `1127·ln(1+hz/700)`, **без slaney-нормировки**, треугольники по бинам `hz·n_fft/sr`, `f_min=0`, `f_max=8000`, 64 фильтра.
- лог: `ln(clip(mel, 1e-9))`. **Нормализацию НЕ применять** (GigaAM её не ждёт).
- декод: greedy CTC (argmax → схлопнуть повторы → убрать blank). vocab: `токен id`, `▁` = пробел.

## Зависимости (ставятся один раз)

```bash
brew install whisper-cpp ffmpeg pango      # ASR-fallback, конвертация, PDF
pip3 install onnxruntime librosa soundfile numpy   # GigaAM
pip3 install torch torchaudio modelscope funasr umap-learn hdbscan addict datasets  # диаризация
```
MPS (GPU Mac) включается автоматически в torch.

## Заметки

- **Время:** ~4 мин на 40-мин запись (диаризация ~2.5 мин + GigaAM ~70 с). Первый запуск дольше — разово качаются модели ModelScope (серверы CN, медленно).
- **Память:** ничего не висит; при сомнении `pgrep -fl "diarize|transcribe|whisper-server"`.
- **Модели onnx-фолбэка** (`diar_models/`) в git не хранятся — подтянуть `python3 fetch_diar_models.py`.
- **Handy** — отдельное приложение (github.com/cjpais/Handy); мы лишь читаем его файлы моделей, ничего не меняя.
