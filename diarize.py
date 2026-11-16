#!/usr/bin/env python3
"""
Транскрипт СО СПИКЕРАМИ, полностью локально:
  sherpa-onnx (pyannote-сегментация + ERes2NetV2-эмбеддинги, кластеризация)
  -> интервалы спикеров;
  GigaAM (CTC) -> текст с таймкодами токенов;
  склейка по времени -> "Speaker k [mm:ss]: текст".

Одноразовый процесс: модели грузятся в RAM, отрабатывают, процесс выходит -> RAM
освобождается. Handy не затрагивается. Rev.ai не нужен.

Использование:
  python3 diarize.py <audio> [--out transcript.txt] [--speakers N] [--threshold 0.5]
"""
import sys, os, json, subprocess, tempfile, argparse
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8"))
GIGAAM_MODEL = os.path.expanduser(CFG["gigaam"]["model"])
GIGAAM_VOCAB = os.path.expanduser(CFG["gigaam"]["vocab"])
SEG = os.path.join(HERE, "diar_models/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx")
EMB_CHOICES = {
    "eres2net_base": "diar_models/eres2net_base.onnx",
    "campplus": "diar_models/campplus.onnx",
    "eres2netv2": "diar_models/embedding.onnx",
}
NTHREADS = os.cpu_count() or 4
SR, N_FFT, HOP, N_MELS, FMIN, FMAX = 16000, 320, 160, 64, 0.0, 8000.0
CHUNK_S = CFG["gigaam"].get("chunk_seconds", 28)


def to_wav(src):
    fd, wav = tempfile.mkstemp(suffix=".wav", prefix="diar_"); os.close(fd)
    subprocess.run(["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", str(SR),
                    "-c:a", "pcm_s16le", wav], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return wav


# ---- GigaAM фичи (точно как в transcribe-rs) ----
def _hz2mel(h): return 1127.0 * np.log(1.0 + h / 700.0)
def _mel2hz(m): return 700.0 * (np.exp(m / 1127.0) - 1.0)
def _mel_fb():
    nb = N_FFT // 2 + 1
    binp = _mel2hz(np.linspace(_hz2mel(FMIN), _hz2mel(FMAX), N_MELS + 2)) * N_FFT / SR
    fb = np.zeros((N_MELS, nb))
    for m in range(N_MELS):
        l, c, r = binp[m], binp[m + 1], binp[m + 2]
        for k in range(nb):
            kf = float(k)
            if l < kf < c: fb[m, k] = (kf - l) / (c - l)
            elif c <= kf < r: fb[m, k] = (r - kf) / (r - c)
    return fb
_FB = _mel_fb()
_WIN = 0.5 * (1.0 - np.cos(2.0 * np.pi * np.arange(N_FFT) / N_FFT))

def _features(y):
    nfr = (len(y) - N_FFT) // HOP + 1
    nb = N_FFT // 2 + 1
    power = np.empty((nb, nfr))
    for i in range(nfr):
        s = i * HOP
        spec = np.fft.rfft(y[s:s + N_FFT] * _WIN, n=N_FFT)
        power[:, i] = spec.real ** 2 + spec.imag ** 2
    return np.log(np.clip(_FB @ power, 1e-9, 1e9)).astype(np.float32)

def _split_points(y):
    if len(y) <= CHUNK_S * SR:
        return [(0, len(y))]
    win = SR // 50
    energy = np.array([np.sum(y[i:i + win] ** 2) for i in range(0, len(y), win)])
    segs, start, step = [], 0, CHUNK_S * SR
    while start < len(y):
        target = start + step
        if target >= len(y): segs.append((start, len(y))); break
        lo, hi = max(target - int(1.5 * SR), start + SR), min(target + int(1.5 * SR), len(y))
        idxs = list(range(lo // win, hi // win))
        cut = (min(idxs, key=lambda k: energy[k]) * win) if idxs else target
        segs.append((start, cut)); start = cut
    return segs


def gigaam_tokens(y):
    """Возвращает (id2tok, BLANK, [(time_sec, token_id), ...]) по всему аудио."""
    backend = CFG["gigaam"].get("backend", "onnx")
    if backend == "gguf":
        from gigaam_gguf import tokens
        return tokens(y, _split_points(y), CFG["gigaam"], SR)
    if backend != "onnx":
        raise ValueError(f"Неизвестный backend GigaAM: {backend}")
    import onnxruntime as ort
    id2tok = {}
    for line in open(GIGAAM_VOCAB, encoding="utf-8").read().split("\n"):
        if not line.strip(): continue
        *tok, idx = line.rsplit(" ", 1); id2tok[int(idx)] = tok[0]
    BLANK = 256
    sess = ort.InferenceSession(GIGAAM_MODEL, providers=["CPUExecutionProvider"])
    toks = []
    for (a, b) in _split_points(y):
        seg = y[a:b]
        if len(seg) < N_FFT: continue
        feat = _features(seg)[None]
        flen = np.array([feat.shape[2]], dtype=np.int64)
        logp = sess.run(["log_probs"], {"features": feat, "feature_lengths": flen})[0][0]
        T = logp.shape[0]
        dur = (b - a) / SR
        t0 = a / SR
        ids = logp.argmax(-1); prev = -1
        for fi, i in enumerate(ids):
            i = int(i)
            if i != prev and i != BLANK:
                toks.append((t0 + (fi + 0.5) * dur / T, i))
            prev = i
    return id2tok, BLANK, toks


def diarize(y, num_speakers, threshold, emb):
    import sherpa_onnx as so
    cfg = so.OfflineSpeakerDiarizationConfig(
        segmentation=so.OfflineSpeakerSegmentationModelConfig(
            pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=SEG),
            num_threads=NTHREADS),
        embedding=so.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=NTHREADS),
        clustering=so.FastClusteringConfig(
            num_clusters=num_speakers if num_speakers else -1,
            threshold=threshold),
        min_duration_on=0.3, min_duration_off=0.5,
    )
    sd = so.OfflineSpeakerDiarization(cfg)
    res = sd.process(y).sort_by_start_time()
    return [(s.start, s.end, s.speaker) for s in res]


def mmss(t): return f"{int(t)//60:02d}:{int(t)%60:02d}"

def _merge_adjacent(segs):
    out = []
    for (a, b, s) in segs:
        if out and out[-1][2] == s and a - out[-1][1] <= 1.0:
            out[-1] = (out[-1][0], b, s)
        else:
            out.append((a, b, s))
    return out

def smooth_segments(segs, min_turn):
    """Убирает короткие «острова» спикеров: сегмент < min_turn поглощается более
    длинным соседом. Повторяем, пока есть что сглаживать."""
    segs = _merge_adjacent(sorted(segs, key=lambda x: x[0]))
    for _ in range(50):  # потолок итераций — защита от зацикливания
        changed = False
        for i, (a, b, s) in enumerate(segs):
            if b - a >= min_turn:
                continue
            neigh = [x for x in (segs[i-1] if i > 0 else None,
                                 segs[i+1] if i < len(segs)-1 else None) if x]
            if not neigh:
                continue
            cand = max(neigh, key=lambda x: x[1] - x[0])
            if cand[2] != s:                       # помечаем только при реальной смене
                segs[i] = (a, b, cand[2]); changed = True
        segs = _merge_adjacent(segs)
        if not changed or len(segs) <= 1:
            break
    return segs

import re as _re
def _is_substantive(txt):
    """Реплика «настоящая», а не островок из пунктуации/одного слова."""
    letters = _re.sub(r"[^\w]", "", txt)
    return len(letters) >= 4

def merge(segments, id2tok, toks, min_turn):
    segments = smooth_segments(segments, min_turn)
    def spk_at(t):
        for (a, b, s) in segments:
            if a <= t <= b: return s
        return min(segments, key=lambda x: abs((x[0]+x[1])/2 - t))[2] if segments else 0
    # 1) собираем сырые блоки (спикер, старт, текст) по сменам спикера
    blocks, cur_spk, cur_ids, cur_start = [], None, [], 0.0
    def flush():
        if cur_ids:
            txt = "".join(id2tok.get(i, "") for i in cur_ids).replace("▁", " ").strip()
            if txt: blocks.append([cur_spk, cur_start, txt])
    for (t, i) in toks:
        s = spk_at(t)
        if s != cur_spk:
            flush(); cur_spk, cur_ids, cur_start = s, [], t
        cur_ids.append(i)
    flush()
    # 2) приклеиваем несущественные островки (пунктуация/1 слово) к соседней реплике
    out = []
    for blk in blocks:
        if out and not _is_substantive(blk[2]):
            out[-1][2] = (out[-1][2] + " " + blk[2]).strip()
        elif out and out[-1][0] == blk[0]:
            out[-1][2] = (out[-1][2] + " " + blk[2]).strip()
        else:
            out.append(blk)
    # 3) повторно сливаем подряд идущих одинаковых спикеров после чистки
    merged = []
    for spk, st, txt in out:
        if merged and merged[-1][0] == spk:
            merged[-1][2] = (merged[-1][2] + " " + txt).strip()
        else:
            merged.append([spk, st, txt])
    return "\n".join(f"Speaker {spk} [{mmss(st)}]: {txt}" for spk, st, txt in merged)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    ap.add_argument("--speakers", type=int, default=0, help="число спикеров (0 = авто)")
    ap.add_argument("--threshold", type=float, default=0.6, help="порог кластеризации (для авто)")
    ap.add_argument("--emb", default="eres2net_base", choices=list(EMB_CHOICES),
                    help="модель эмбеддингов спикеров")
    ap.add_argument("--min-turn", type=float, default=2.0,
                    help="мин. длительность реплики спикера (сек) — короче поглощается соседом")
    args = ap.parse_args()
    emb = os.path.join(HERE, EMB_CHOICES[args.emb])

    wav = to_wav(args.audio)
    try:
        import soundfile as sf
        y, _ = sf.read(wav, dtype="float32")
        if y.ndim > 1: y = y.mean(axis=1)
        sys.stderr.write(f"[diarize] сегментация + эмбеддинги ({args.emb}, порог {args.threshold})...\n")
        segs = diarize(y, args.speakers, args.threshold, emb)
        nspk = len(set(s for _, _, s in segs))
        sys.stderr.write(f"[diarize] кластеров: {nspk}, сегментов: {len(segs)}\n")
        sys.stderr.write("[diarize] распознавание GigaAM...\n")
        id2tok, _, toks = gigaam_tokens(y)
        text = merge(segs, id2tok, toks, args.min_turn)
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
