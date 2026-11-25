"""Clean five-second excerpts and transient CAM++ embeddings for manual review."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

RATE = 16_000
CLIP_SECONDS = 5
MARGIN = 0.25


def clean_windows(segments, speaker):
    """Exclude every overlap and keep a margin at all speech boundaries."""
    own = sorted((row["start"] + MARGIN, row["end"] - MARGIN)
                 for row in segments if row["speaker"] == speaker)
    others = sorted((row["start"] - MARGIN, row["end"] + MARGIN)
                    for row in segments if row["speaker"] != speaker)
    available = []
    for start, end in own:
        for left, right in others:
            if right <= start:
                continue
            if left >= end:
                break
            if left - start >= CLIP_SECONDS:
                available.append((start, left))
            start = max(start, right)
        if end - start >= CLIP_SECONDS:
            available.append((start, end))
    choices = []
    for start, end in sorted(available, key=lambda bounds: -(bounds[1] - bounds[0])):
        count = min(3, (int((end - start + MARGIN) // (CLIP_SECONDS + MARGIN))))
        count = max(1, count)
        for index in range(count):
            space = end - start - (count * CLIP_SECONDS + (count - 1) * MARGIN)
            offset = start + max(0, space / 2) + index * (CLIP_SECONDS + MARGIN)
            if all(abs(offset - existing) >= CLIP_SECONDS for existing in choices):
                choices.append(offset)
            if len(choices) == 3:
                return choices
    return choices


def pcm(source, start):
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", repr(start), "-i", source,
         "-t", str(CLIP_SECONDS), "-vn", "-ar", str(RATE), "-ac", "1", "-f", "s16le", "pipe:1"],
        check=True, capture_output=True, timeout=45,
    ).stdout
    if len(raw) != RATE * CLIP_SECONDS * 2:
        raise ValueError("No complete five-second sample")
    return raw


def review_features(source, starts):
    import numpy as np
    import torch
    from modelscope.models import Model
    from model_cache import prepare_models

    audio, used = [], []
    for start in starts:
        waveform = np.frombuffer(pcm(source, start), dtype="<i2").astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(waveform ** 2)))
        lively = float(np.mean(np.max(np.abs(waveform.reshape(-1, RATE // 10)), axis=1) >= 0.012))
        if rms < 0.003 or lively < 0.65 or np.mean(np.abs(waveform) > 0.99) > 0.02:
            continue
        audio.append(waveform)
        used.append(start)
    if not audio:
        return {"examples": []}
    _, paths = prepare_models()
    model_dir = Path(paths["speaker_model"])
    model = Model.from_pretrained(str(model_dir), device="cpu")
    config = json.loads((model_dir / "configuration.json").read_text())
    with (model_dir / config["model_file"]).open("rb") as source_weights:
        fingerprint = hashlib.file_digest(source_weights, "sha256").hexdigest()
    with torch.inference_mode():
        vectors = model.forward(np.stack(audio)).numpy()
    examples = []
    for start, vector in zip(used, vectors):
        length = np.linalg.norm(vector)
        if np.isfinite(length) and length > 0:
            examples.append({"start": start, "vector": (vector / length).tolist()})
    return {"encoder": f"campplus:{fingerprint}:pcm16-s16le-v1:{vectors.shape[1]}",
            "examples": examples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording")
    parser.add_argument("segments")
    parser.add_argument("--speaker", type=int)
    args = parser.parse_args()
    diarization = json.loads(Path(args.segments).read_text())
    segments = diarization["speakerSegments"]
    if args.speaker is None:
        result = [{"speaker": speaker, "hasSample": bool(clean_windows(segments, speaker))}
                  for speaker in sorted({row["speaker"] for row in segments})]
    else:
        result = review_features(args.recording, clean_windows(segments, args.speaker))
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
