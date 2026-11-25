"""Run the optional, local-only FluidAudio helper on Apple Silicon."""
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import tempfile


def diarize(helper, wav, duration, speaker_count=None):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("FluidAudio requires an Apple Silicon Mac")
    helper = Path(helper).expanduser().resolve(strict=True)
    if not helper.is_file() or not os.access(helper, os.X_OK):
        raise ValueError("FluidAudio helper is not executable")

    with tempfile.TemporaryDirectory(prefix="lt-fluid-") as tmp:
        output = Path(tmp) / "segments.json"
        command = [str(helper), str(Path(wav).resolve()), str(output)]
        if speaker_count is not None:
            command.append(str(speaker_count))
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, timeout=max(90, duration + 30))
        rows = json.loads(output.read_text())

    speakers = {}
    segments = []
    for row in sorted(rows, key=lambda row: (row["start"], row["end"], row["speaker"])):
        start, end = float(row["start"]), float(row["end"])
        if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end <= duration + 0.02:
            raise ValueError("FluidAudio returned an invalid segment")
        label = row["speaker"]
        if not isinstance(label, str) or not label:
            raise ValueError("FluidAudio returned an invalid cluster label")
        if start < duration:
            segments.append((start, min(end, duration), speakers.setdefault(label, len(speakers))))
    if speaker_count is not None and len(speakers) != speaker_count:
        raise ValueError("FluidAudio did not satisfy the speaker count constraint")
    return segments
