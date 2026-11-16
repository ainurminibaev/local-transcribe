#!/usr/bin/env python3
"""Read-only capability probe; never downloads models or starts recognition."""
import glob
import importlib.util
import json
from pathlib import Path
import platform
import shutil


def probe():
    config = json.loads((Path(__file__).parent / 'config.json').read_text())
    missing = [name for name in ['numpy', 'soundfile', 'librosa', 'torch', 'torchaudio', 'modelscope', 'funasr', 'simplejson', 'sortedcontainers']
               if importlib.util.find_spec(name) is None]
    backend = config['gigaam'].get('backend', 'onnx')
    package = 'transcribe_cpp' if backend == 'gguf' else 'onnxruntime'
    if importlib.util.find_spec(package) is None: missing.append(package)
    models = []
    if backend == 'gguf':
        models = glob.glob(str(Path(config['gigaam']['gguf_model']).expanduser()))
    else:
        models = [str(Path(config['gigaam']['model']).expanduser())]
    if not any(Path(m).is_file() for m in models): missing.append('GigaAM model')
    if not shutil.which('ffmpeg'): missing.append('ffmpeg')
    try:
        from model_cache import prepare_models
        prepare_models()
        models_cached = True
    except (FileNotFoundError, KeyError, ValueError) as exc:
        models_cached = False
        missing.append(str(exc))
    device = 'cpu'
    if 'torch' not in missing:
        try:
            import torch
            if torch.backends.mps.is_available(): device = 'mps'
            elif torch.cuda.is_available(): device = 'cuda'
        except Exception as exc:
            missing.append('torch import: ' + str(exc))
    return {'ready': not missing, 'device': device, 'platform': platform.system(),
            'inputs': ['ffmpeg-audio', 'ffmpeg-video'], 'outputs': ['transcript', 'segments', 'audio', 'source', 'samples'], 'supportsSpeakerCount': True,
            'modelsCached': models_cached, 'engine': 'gigaam-' + backend, 'speakers': True, 'missing': missing,
            'asrDevice': 'metal' if platform.system() == 'Darwin' and platform.machine() == 'arm64' and backend == 'gguf' else device,
            'pdfReady': bool(shutil.which('pandoc') and shutil.which('weasyprint'))}


if __name__ == '__main__': print(json.dumps(probe(), ensure_ascii=False))
