"""Resolve the complete ModelScope stack locally; download only during setup."""
import json
import os
from pathlib import Path

DIARIZATION_MODEL = 'iic/speech_campplus_speaker-diarization_common'


def resolve_model(model_id, download=False):
    roots = [Path.home()/'.cache/modelscope/hub/models', Path.home()/'.cache/modelscope/hub']
    if os.environ.get('MODELSCOPE_CACHE'):
        root = Path(os.environ['MODELSCOPE_CACHE']).expanduser()
        roots = [root/'models', root, *roots]
    for root in roots:
        path = root/model_id
        config_path = path/'configuration.json'
        if not config_path.is_file(): continue
        cfg = json.loads(config_path.read_text())
        weights = [cfg.get('model_file'), cfg.get('file_path_metas', {}).get('init_param')]
        weights += [cfg.get('model', {}).get(key) for key in
                    ['pretrained_model', 'pretrained_encoder', 'pretrained_backend']]
        if all((path/name).is_file() for name in weights if isinstance(name, str)):
            return str(path)
    if download:
        from download_modelscope import download_model
        return download_model(model_id,roots[0]/model_id)
    raise FileNotFoundError(f'Local ModelScope model not found: {model_id}. Run scripts/setup_worker.py --download-model')


def prepare_models(download=False):
    top = resolve_model(DIARIZATION_MODEL, download)
    cfg = json.loads((Path(top)/'configuration.json').read_text())
    children = {key: resolve_model(cfg['model'][key], download)
                for key in ['speaker_model', 'vad_model', 'change_locator'] if key in cfg['model']}
    return top, children
