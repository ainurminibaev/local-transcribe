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
import sys, os, subprocess, tempfile, argparse
import re

import numpy as np

from gigaam_config import load_config

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = load_config(HERE)
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


def gigaam_tokens(y, vocabulary=()):
    """Возвращает (id2tok, BLANK, [(start_sec, token_id, end_sec), ...]) по всему аудио."""
    backend = CFG["gigaam"].get("backend", "onnx")
    if backend == "gguf":
        from gigaam_gguf import tokens
        return tokens(y, _split_points(y), CFG["gigaam"], SR, vocabulary)
    if backend != "onnx":
        raise ValueError(f"Неизвестный backend GigaAM: {backend}")
    import onnxruntime as ort
    id2tok = {}
    for line in open(GIGAAM_VOCAB, encoding="utf-8").read().split("\n"):
        if not line.strip(): continue
        *tok, idx = line.rsplit(" ", 1); id2tok[int(idx)] = tok[0]
    BLANK = 256
    chunk_boundary = -1
    id2tok[chunk_boundary] = " "
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
        if vocabulary:
            from ctc_context import frame_ids
            ids = frame_ids(logp, id2tok, BLANK, vocabulary)
        else:
            ids = logp.argmax(-1)
        if toks:
            toks.append((t0, chunk_boundary, t0))
        prev = -1
        for fi, i in enumerate(ids):
            i = int(i)
            if i != prev and i != BLANK:
                toks.append((t0 + fi * dur / T, i, t0 + (fi + 1) * dur / T))
            elif i != BLANK:
                start, token_id, _ = toks[-1]
                toks[-1] = (start, token_id, t0 + (fi + 1) * dur / T)
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

def timed_words(pieces, tokens):
    """Assemble whole words before inspecting speaker boundaries."""
    parts = []
    start = end = 0.0
    for token in tokens:
        first, index = token[:2]
        last = token[2] if len(token) == 3 else first
        piece = pieces.get(index, "").replace("▁", " ")
        for chunk in re.findall(r"\s+|\S+", piece):
            if chunk.isspace():
                if parts:
                    yield start, end, "".join(parts)
                    parts = []
                continue
            if not parts:
                start, end = first, last
            parts.append(chunk)
            end = max(end, last)
    if parts:
        yield start, end, "".join(parts)


def word_turns(segments, words):
    """Use a speaker label only if exactly one voice intersects the word."""
    pending = iter(sorted(segments))
    upcoming = next(pending, None)
    active = []
    turns = []
    for start, end, word in words:
        active = [span for span in active if span[1] > start]
        while upcoming and (upcoming[0] < end or upcoming[0] <= start):
            if upcoming[1] > start:
                active.append(upcoming)
            upcoming = next(pending, None)
        voices = {speaker for left, _, speaker in active if left <= start or left < end}
        speaker = next(iter(voices)) if len(voices) == 1 else None
        if turns and turns[-1]["speaker"] == speaker and start - turns[-1]["end"] < 0.8:
            turns[-1]["text"] += " " + word
            turns[-1]["end"] = max(end, turns[-1]["end"])
        else:
            turns.append({"speaker": speaker, "start": start, "end": end, "text": word})
    return turns


def transcript_gaps(words, speech, duration):
    """Flag gaps of 3 s, or gaps with at least 0.8 s of detected speech."""
    speech = sorted(speech)
    cursor = 0.0
    speech_index = 0
    gaps = []
    for start, end in [(a, b) for a, b, word in words if any(char.isalnum() for char in word)] + [(duration, duration)]:
        start = min(start, duration)
        if start > cursor:
            while speech_index < len(speech) and speech[speech_index][1] <= cursor:
                speech_index += 1
            has_speech = False
            for index in range(speech_index, len(speech)):
                left, right, _ = speech[index]
                if left >= start:
                    break
                if min(start, right) - max(cursor, left) >= 0.8:
                    has_speech = True
                    break
            if has_speech or start - cursor >= 3:
                gaps.append({"start": cursor, "end": start, "speechDetected": has_speech})
        cursor = max(cursor, end)
    return gaps


def render_transcript(turns, gaps=()):
    entries = []
    for turn in turns:
        speaker = turn["speaker"]
        label = f"Speaker {speaker}" if speaker is not None else "Говорящий неясен"
        entries.append((turn["start"], f'{label} [{mmss(turn["start"])}]: {turn["text"]}'))
    for gap in gaps:
        times = f'{mmss(gap["start"])}–{mmss(gap["end"])}'
        label = "речь обнаружена" if gap["speechDetected"] else "речь не подтверждена"
        entries.append((gap["start"], f"[{times}] Нет распознанного текста ({label})"))
    return "\n".join(line for _, line in sorted(entries, key=lambda item: item[0]))


def merge(segments, id2tok, toks, min_turn=0):
    # Retain the legacy argument for callers, but never reassign short turns.
    return render_transcript(word_turns(segments, timed_words(id2tok, toks)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    ap.add_argument("--speakers", type=int, default=0, help="число спикеров (0 = авто)")
    ap.add_argument("--threshold", type=float, default=0.6, help="порог кластеризации (для авто)")
    ap.add_argument("--emb", default="eres2net_base", choices=list(EMB_CHOICES),
                    help="модель эмбеддингов спикеров")
    ap.add_argument("--min-turn", type=float, help=argparse.SUPPRESS)
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
