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
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8"))

GIGAAM_MODEL = os.path.expanduser(CFG["gigaam"]["model"])
GIGAAM_VOCAB = os.path.expanduser(CFG["gigaam"]["vocab"])
WHISPER_MODEL = os.path.expanduser(CFG["whisper"]["model"])
WHISPER_BIN = CFG["whisper"]["bin"]
SR, N_FFT, HOP, N_MELS, FMIN, FMAX = 16000, 320, 160, 64, 0.0, 8000.0
CHUNK_S = CFG["gigaam"].get("chunk_seconds", 28)


def to_wav(src):
    """ffmpeg -> 16k mono PCM wav во временный файл. Возвращает путь."""
    fd, wav = tempfile.mkstemp(suffix=".wav", prefix="trx_")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", wav],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return wav


# ---------- GigaAM (точная копия препроцессинга transcribe-rs) ----------
def _hz2mel(hz): return 1127.0 * np.log(1.0 + hz / 700.0)
def _mel2hz(m):  return 700.0 * (np.exp(m / 1127.0) - 1.0)

def _mel_fb():
    nb = N_FFT // 2 + 1
    mp = np.linspace(_hz2mel(FMIN), _hz2mel(FMAX), N_MELS + 2)
    binp = _mel2hz(mp) * N_FFT / SR
    fb = np.zeros((N_MELS, nb))
    for m in range(N_MELS):
        l, c, r = binp[m], binp[m + 1], binp[m + 2]
        for k in range(nb):
            kf = float(k)
            if l < kf < c:   fb[m, k] = (kf - l) / (c - l)
            elif c <= kf < r: fb[m, k] = (r - kf) / (r - c)
    return fb

def _features(y):
    win = 0.5 * (1.0 - np.cos(2.0 * np.pi * np.arange(N_FFT) / N_FFT))  # periodic Hann
    nfr = (len(y) - N_FFT) // HOP + 1
    nb = N_FFT // 2 + 1
    power = np.empty((nb, nfr))
    for i in range(nfr):
        s = i * HOP
        spec = np.fft.rfft(y[s:s + N_FFT] * win, n=N_FFT)
        power[:, i] = spec.real ** 2 + spec.imag ** 2
    mel = _mel_fb() @ power
    return np.log(np.clip(mel, 1e-9, 1e9)).astype(np.float32)  # [64, T]

def _split_points(y):
    """Границы чанков ~CHUNK_S c, сдвинутые к локальному минимуму энергии (по тишине)."""
    win = SR // 50  # 20ms
    if len(y) <= CHUNK_S * SR:
        return [(0, len(y))]
    energy = np.array([np.sum(y[i:i + win] ** 2) for i in range(0, len(y), win)])
    segs, start = [], 0
    step = CHUNK_S * SR
    while start < len(y):
        target = start + step
        if target >= len(y):
            segs.append((start, len(y))); break
        lo, hi = max(target - int(1.5 * SR), start + SR), min(target + int(1.5 * SR), len(y))
        idxs = range(lo // win, hi // win)
        cut = min(idxs, key=lambda k: energy[k]) * win if list(idxs) else target
        segs.append((start, cut)); start = cut
    return segs

def gigaam(wav):
    import soundfile as sf
    y, _ = sf.read(wav, dtype="float32")
    if y.ndim > 1: y = y.mean(axis=1)
    backend = CFG["gigaam"].get("backend", "onnx")
    if backend == "gguf":
        from gigaam_gguf import tokens
        pieces, _, timed = tokens(y, _split_points(y), CFG["gigaam"], SR)
        return "".join(pieces[index] for _, index in timed).replace("▁", " ").strip()
    if backend != "onnx":
        raise ValueError(f"Неизвестный backend GigaAM: {backend}")
    import onnxruntime as ort
    id2tok = {}
    for line in open(GIGAAM_VOCAB, encoding="utf-8").read().split("\n"):
        if not line.strip(): continue
        *tok, idx = line.rsplit(" ", 1); id2tok[int(idx)] = tok[0]
    BLANK = 256
    sess = ort.InferenceSession(GIGAAM_MODEL, providers=["CPUExecutionProvider"])
    parts = []
    for (a, b) in _split_points(y):
        seg = y[a:b]
        if len(seg) < N_FFT: continue
        feat = _features(seg)[None]
        flen = np.array([feat.shape[2]], dtype=np.int64)
        logp = sess.run(["log_probs"], {"features": feat, "feature_lengths": flen})[0][0]
        ids = logp.argmax(-1); out = []; prev = -1
        for i in ids:
            if i != prev and i != BLANK: out.append(int(i))
            prev = i
        parts.append("".join(id2tok.get(i, "") for i in out).replace("▁", " ").strip())
    return " ".join(p for p in parts if p).strip()


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
    ap.add_argument("--engine", choices=["gigaam", "whisper"], default="gigaam")
    args = ap.parse_args()

    order = [args.engine]  # Альтернативный движок выбирается только явно.
    wav = to_wav(args.audio)
    text, used = "", None
    try:
        for eng in order:
            if eng == "rev.ai":   # доступен только через MCP -> сигнал ассистенту
                continue
            try:
                fn = {"gigaam": gigaam, "whisper": whisper}[eng]
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
