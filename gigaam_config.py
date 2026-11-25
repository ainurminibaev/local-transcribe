"""Shared GigaAM configuration for recognition and discovery."""
import json
import os
from pathlib import Path


def load_config(root):
    config = json.loads((Path(root) / "config.json").read_text(encoding="utf-8"))
    # Opt in to an independently provisioned GigaAM CTC ONNX bundle.
    if directory := os.getenv("LOCAL_TRANSCRIBE_GIGAAM_ONNX_DIR"):
        bundle = Path(directory).expanduser().resolve()
        config["gigaam"].update(backend="onnx", model=str(bundle / "model.int8.onnx"),
                                vocab=str(bundle / "tokens.txt"))
    return config
