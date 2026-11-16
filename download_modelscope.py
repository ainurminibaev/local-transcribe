"""Download pinned public ModelScope runtime files without hub authentication."""
import hashlib
import json
from pathlib import Path
import uuid

MANIFEST=Path(__file__).resolve().parent/'models-manifest.json'


def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda:source.read(1048576),b''):value.update(chunk)
    return value.hexdigest()


def download_model(model_id,destination):
    import requests
    entry=json.loads(MANIFEST.read_text())['models'][model_id]
    root=Path(destination);root.mkdir(parents=True,exist_ok=True)
    for name,expected in entry['files'].items():
        target=root/name
        if target.is_file() and digest(target)==expected:continue
        temporary=target.with_name(target.name+'.part-'+uuid.uuid4().hex)
        try:
            url=f'https://modelscope.cn/api/v1/models/{model_id}/repo'
            with requests.get(url,params={'Revision':entry['revision'],'FilePath':name},stream=True,timeout=(15,120)) as response:
                response.raise_for_status()
                with temporary.open('xb') as output:
                    for chunk in response.iter_content(1048576):output.write(chunk)
            if digest(temporary)!=expected:raise ValueError(f'Public model checksum mismatch: {model_id}/{name}')
            temporary.replace(target)
        finally:
            if temporary.exists():temporary.unlink()
    return str(root)
