# Сравнение FluidAudio и ModelScope

Этот эксперимент не меняет настройки BB. GigaAM распознаёт текст в обоих вариантах.
FluidAudio поставляется отдельно по [Apache 2.0](https://github.com/FluidInference/FluidAudio/blob/v0.18.4/LICENSE).
Условия и происхождение моделей описаны в [репозитории Core ML](https://huggingface.co/FluidInference/speaker-diarization-coreml).

На Apple Silicon с macOS 14+ и Swift 6 проверьте свободное место на диске. Сборку можно хранить на отдельном томе, кэш моделей FluidAudio по умолчанию находится в `~/Library/Application Support/FluidAudio/Models`. Режим подготовки скачивает модели только по явной команде.

```sh
swift build --package-path tools/fluidaudio-diarizer -c release
helper="$(swift build --package-path tools/fluidaudio-diarizer -c release --show-bin-path)/lt-fluid-diarize"
"$helper" --prepare-models
```

Подготовьте 3–5 разных записей и независимую разметку RTTM. Разметьте смены говорящих и перекрытия вручную. Старый транскрипт может помочь найти интервалы, но разметка ModelScope сама по себе не может служить эталоном для сравнения. RTTM должен покрывать весь проверяемый фрагмент, включая паузы.

```sh
python3 tools/benchmark_diarization.py --helper "$helper" \
  --case meeting-a.wav meeting-a.rttm \
  --case meeting-b.wav meeting-b.rttm \
  --case meeting-c.wav meeting-c.rttm
```

Скрипт измеряет время диаризации с загрузкой моделей, но без подготовки WAV и ASR.
DER учитывает пропущенную речь, ложные срабатывания и потерю спикера. Скрипт
перенумеровывает кластеры оптимальным сопоставлением, учитывает перекрытия
и не исключает края реплик. Переключать по умолчанию можно после сравнения,
если FluidAudio быстрее на наборе, а DER не вырос ни на одной записи.
Отдельно стоит прослушать спорные стыки и короткие реплики.

Для одиночного прогона:

```sh
LOCAL_TRANSCRIBE_FLUIDAUDIO="$helper" python3 diarize_ms.py meeting.wav --out transcript.txt --json-out segments.json
```

Сервисный запуск FluidAudio работает без сети и при ошибке возвращается на ModelScope.
Тип диаризации и предупреждение о переходе видны в JSON. Без переменной
`LOCAL_TRANSCRIBE_FLUIDAUDIO` работает ModelScope.
