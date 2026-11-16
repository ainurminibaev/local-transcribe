import json
from pathlib import Path
import time


def progress(directory,stage,**details):
    if not directory:return
    path=Path(directory)/'progress.json';path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix('.json.part')
    temporary.write_text(json.dumps({'stage':stage,'at':time.time()*1000,**details}))
    temporary.replace(path)
