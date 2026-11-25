#!/usr/bin/env python3
"""
Локальная транскрибация с цепочкой движков: GigaAM (главный) -> Whisper (fallback).
Rev.ai остаётся последним fallback, но он доступен только через MCP, поэтому
вызывается ассистентом вручную, если локальные движки не справились.

Принципы:
- Одноразовый процесс: модель грузится в RAM, отрабатывает и процесс завершается ->
  ОС освобождает память. Никаких демонов/серверов. Handy не затрагивается (только
  читаем её файлы моделей).
- GigaAM: CTC-модель, препроцессинг точь-в-точь как в transcribe-rs (движок Handy).

Использование:
    python3 transcribe.py <audio> [--out transcript.txt] [--engine gigaam|whisper]
"""
import sys, os, json, subprocess, tempfile, argparse, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8"))

WHISPER_MODEL = os.path.expanduser(CFG["whisper"]["model"])
WHISPER_BIN = CFG["whisper"]["bin"]
SR = 16000

def to_wav(src):
    """ffmpeg -> 16k mono PCM wav во временный файл. Возвращает путь."""
    fd, wav = tempfile.mkstemp(suffix=".wav", prefix="trx_")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", wav],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return wav


def gigaam(wav, vocabulary=()):
    import soundfile as sf
    from diarize import gigaam_tokens, render_transcript, timed_words, transcript_gaps
    y, _ = sf.read(wav, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    pieces, _, timed = gigaam_tokens(y, vocabulary)
    words = list(timed_words(pieces, timed))
    gaps = transcript_gaps(words, (), len(y) / SR)
    if not gaps:
        return " ".join(word for _, _, word in words)
    parts = [(start, word) for start, _, word in words]
    parts += [(gap["start"], "\n" + render_transcript([], [gap]) + "\n") for gap in gaps]
    return " ".join(part for _, part in sorted(parts, key=lambda item: item[0])).strip()


# ---------- Whisper (whisper.cpp, модель Handy) ----------
def whisper(wav):
    r = subprocess.run(
        [WHISPER_BIN, "-m", WHISPER_MODEL, "-l", "ru", "-nt", "-f", wav],
        check=True, capture_output=True, text=True,
    )
    return " ".join(line.strip() for line in r.stdout.splitlines() if line.strip()).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    ap.add_argument("--vocabulary-file")
    ap.add_argument("--engine", choices=["gigaam", "whisper"], default="gigaam")
    args = ap.parse_args()

    from pathlib import Path
    vocabulary = json.loads(Path(args.vocabulary_file).read_text()) if args.vocabulary_file else []
    order = [args.engine]  # Альтернативный движок выбирается только явно.
    wav = to_wav(args.audio)
    text, used = "", None
    try:
        for eng in order:
            if eng == "rev.ai":   # доступен только через MCP -> сигнал ассистенту
                continue
            try:
                fn = {"gigaam": lambda path: gigaam(path, vocabulary), "whisper": whisper}[eng]
                sys.stderr.write(f"[transcribe] движок: {eng}\n")
                text = fn(wav)
                if text and len(text) > 20:
                    used = eng; break
            except Exception as e:
                sys.stderr.write(f"[transcribe] {eng} не сработал: {e}\n")
    finally:
        os.remove(wav)  # чистим временный wav

    if not used:
        sys.stderr.write("[transcribe] выбранный движок не справился; автоматической замены нет\n")
        sys.exit(2)

    if args.out:
        open(args.out, "w", encoding="utf-8").write(text + "\n")
        print(f"OK [{used}] -> {args.out} ({len(text)} символов)")
    else:
        print(text)


if __name__ == "__main__":
    main()
