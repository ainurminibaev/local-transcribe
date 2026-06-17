#!/usr/bin/env python3
"""
Транскрипт СО СПИКЕРАМИ — готовый стек, без токенов:
  ModelScope 3D-Speaker (VAD + сегментация + CAM++ эмбеддинги + кластеризация,
  модели тянутся с ModelScope, PyTorch/MPS) -> интервалы спикеров;
  GigaAM (CTC) -> текст с таймкодами; склейка по времени.

Одноразовый процесс: модели в RAM -> отработал -> вышел -> RAM свободна.
Handy не трогаем. HuggingFace-токен не нужен.

  python3 diarize_ms.py <audio> [--out transcript.txt]
"""
import sys, os, time, argparse
os.environ.setdefault("MODELSCOPE_LOG_LEVEL", "40")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import diarize as D  # переиспользуем GigaAM (gigaam_tokens, to_wav, _merge_adjacent, mmss)


def diarize_ms(wav):
    from modelscope.pipelines import pipeline
    from modelscope.utils.constant import Tasks
    sd = pipeline(task=Tasks.speaker_diarization,
                  model='iic/speech_campplus_speaker-diarization_common')
    res = sd(wav)
    return [(float(a), float(b), int(s)) for a, b, s in res['text']]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    wav = D.to_wav(args.audio)
    try:
        import soundfile as sf
        y, _ = sf.read(wav, dtype="float32")
        if y.ndim > 1: y = y.mean(axis=1)
        sys.stderr.write("[diarize_ms] диаризация (ModelScope, MPS)...\n")
        t0 = time.time()
        segs = D._merge_adjacent(sorted(diarize_ms(wav), key=lambda x: x[0]))
        sys.stderr.write(f"[diarize_ms] спикеров: {len(set(s for *_, s in segs))}, "
                         f"сегментов: {len(segs)}, {round(time.time()-t0,1)} с\n")
        sys.stderr.write("[diarize_ms] распознавание GigaAM...\n")
        id2tok, _, toks = D.gigaam_tokens(y)
        text = D.merge(segs, id2tok, toks, min_turn=1.5)  # сглаживаем короткие островки
        nspk = len(set(int(l.split()[1]) for l in text.splitlines() if l.startswith("Speaker")))
    finally:
        os.remove(wav)

    if args.out:
        open(args.out, "w", encoding="utf-8").write(text + "\n")
        print(f"OK -> {args.out} ({nspk} спикеров, {len(text)} символов)")
    else:
        print(text)


if __name__ == "__main__":
    main()
