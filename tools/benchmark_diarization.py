#!/usr/bin/env python3
"""Compare two diarizers on 3–5 WAV-convertible recordings with independent RTTM."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sys
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from scipy.optimize import linear_sum_assignment
import soundfile as sf

import diarize
from diarize_ms import diarize_ms
import fluidaudio_diarization


def load_rttm(path):
    spans = []
    recording = None
    for line in path.read_text().splitlines():
        columns = line.split()
        if not columns or line.lstrip().startswith("#"):
            continue
        kind, name, _, start, duration, _, _, speaker, *_ = columns
        if kind != "SPEAKER" or (recording and recording != name):
            raise ValueError(f"Expected one recording's SPEAKER rows in {path}")
        recording = name
        spans.append((float(start), float(start) + float(duration), speaker))
    if not spans:
        raise ValueError(f"No reference speech in {path}")
    return spans


def score(reference, hypothesis, duration):
    """Duration-weighted DER, including overlaps, without a boundary collar."""
    for spans in (reference, hypothesis):
        for start, end, _ in spans:
            if not 0 <= start < end <= duration + 0.02:
                raise ValueError(f"Invalid RTTM or prediction span {start}–{end} for {duration}s audio")
    events = sorted(
        (min(time, duration), side, speaker, delta)
        for side, spans in enumerate((reference, hypothesis))
        for start, end, speaker in spans
        for time, delta in ((start, 1), (end, -1))
    )
    active = [Counter(), Counter()]
    overlap = Counter()
    reference_seconds = miss = false_alarm = comparable = previous = 0.0
    for time, side, speaker, delta in events:
        elapsed = time - previous
        truth, predicted = (set(group) for group in active)
        reference_seconds += elapsed * len(truth)
        miss += elapsed * max(0, len(truth) - len(predicted))
        false_alarm += elapsed * max(0, len(predicted) - len(truth))
        comparable += elapsed * min(len(truth), len(predicted))
        for expected in truth:
            for found in predicted:
                overlap[expected, found] += elapsed
        active[side][speaker] += delta
        if not active[side][speaker]:
            del active[side][speaker]
        previous = time
    if not reference_seconds:
        raise ValueError("Reference does not contain valid speech within the audio")
    matrix = np.array([
        [overlap[left, right] for right in sorted({s for _, _, s in hypothesis})]
        for left in sorted({s for _, _, s in reference})
    ])
    matching = matrix[linear_sum_assignment(matrix, maximize=True)].sum()
    confusion = max(0.0, comparable - matching)
    return {"der": (miss + false_alarm + confusion) / reference_seconds,
            "missSeconds": miss, "falseAlarmSeconds": false_alarm, "confusionSeconds": confusion}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", required=True)
    parser.add_argument("--case", action="append", nargs=2, metavar=("AUDIO", "RTTM"), required=True)
    args = parser.parse_args()
    if not 3 <= len(args.case) <= 5:
        parser.error("Pass 3–5 recordings and their independently annotated RTTMs")
    cases = [(Path(audio).resolve(), Path(reference).resolve()) for audio, reference in args.case]
    if len(set(audio for audio, _ in cases)) != len(cases):
        parser.error("Pass different recordings")
    results = []
    for audio, reference in cases:
        truth = load_rttm(reference)
        wav = diarize.to_wav(str(audio))
        try:
            samples, rate = sf.read(wav, dtype="float32")
            duration = len(samples) / rate
            row = {"file": audio.name, "durationSeconds": duration}
            for label, run in (
                ("modelscope", lambda: diarize_ms(wav, samples)),
                ("fluidaudio", lambda: fluidaudio_diarization.diarize(args.helper, wav, duration)),
            ):
                start = perf_counter()
                segments = run()
                elapsed = perf_counter() - start
                row[label] = {**score(truth, segments, duration), "seconds": elapsed}
            results.append(row)
        finally:
            os.unlink(wav)
    print(json.dumps({
        "recordings": results,
        "noDerRegression": all(row["fluidaudio"]["der"] <= row["modelscope"]["der"]
                              for row in results),
        "fasterOnCorpus": sum(row["fluidaudio"]["seconds"] for row in results)
                         < sum(row["modelscope"]["seconds"] for row in results),
    }, indent=2))


if __name__ == "__main__":
    main()
