"""Stop a local worker when its server-issued execution lease expires."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def valid_lease(path, token, now=None):
    try:
        value=json.loads(Path(path).read_text())
        return value['token']==token and value['expiresAt']>(time.time()*1000 if now is None else now)
    except (OSError,KeyError,ValueError,TypeError):
        return False


def stop_process(process):
    if process.poll() is not None:return
    if os.name=='posix':
        try:os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError:return
    else:process.terminate()
    try:process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        if os.name=='posix':
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        else:process.kill()
        process.wait(timeout=3)


def supervise(command,lease_path,token,interval=1.0):
    # Wall time includes sleep on macOS: a sleeping laptop cannot resume an
    # expired attempt after the server has already selected another service.
    if not valid_lease(lease_path,token):return 124
    process=subprocess.Popen(command,start_new_session=os.name=='posix')
    try:
        while True:
            if not valid_lease(lease_path,token):
                print('[lease] expired; stopping this attempt',file=sys.stderr,flush=True)
                stop_process(process)
                return 124
            status=process.poll()
            if status is not None:return status
            time.sleep(interval)
    except BaseException:
        stop_process(process)
        raise
