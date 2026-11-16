#!/usr/bin/env python3
"""Install an isolated local-transcribe worker on macOS or Linux."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--download-model', action='store_true', help='Download the public GigaAM GGUF model; no audio is uploaded')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--cpu', action='store_true', help='Install Linux CPU-only PyTorch wheels before the other dependencies')
    ap.add_argument('--venv',help='Plugin-owned environment path')
    ap.add_argument('--reuse-system-packages',action='store_true',help='Adopt an already working Mac Python without modifying global packages')
    ap.add_argument('--requirements-id',default='manual')
    args = ap.parse_args()
    if sys.version_info < (3,10): raise SystemExit('Python >= 3.10 is required')
    if not shutil.which('ffmpeg'):
        raise SystemExit('Install ffmpeg first: brew install ffmpeg (macOS), apt install ffmpeg (Debian/Ubuntu)')
    env = Path(args.venv).expanduser().resolve() if args.venv else ROOT / '.venv'
    python = env / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    plan = []
    locked=ROOT/'requirements-cpu-py312.lock'
    if args.cpu and sys.version_info[:2]==(3,12) and locked.exists():
        plan.append([str(python),'-m','pip','install','-r',str(locked)])
    else:
        if args.cpu:
            plan.append([str(python), '-m', 'pip', 'install', 'torch', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cpu'])
        plan.append([str(python), '-m', 'pip', 'install', '-r', str(ROOT/'requirements.txt')])
    if args.download_model:
        plan.append([str(python), '-c', "import json\nfrom gigaam_gguf import resolve_model\ntry:\n resolve_model(json.load(open('config.json'))['gigaam'])\nexcept FileNotFoundError:\n from huggingface_hub import hf_hub_download\n hf_hub_download(repo_id='handy-computer/gigaam-v3-e2e-ctc-gguf',filename='gigaam-v3-e2e-ctc-Q8_0.gguf')"])
        plan.append([str(python), '-c', 'from model_cache import prepare_models; prepare_models(download=True)'])
    plan.append([str(python), str(ROOT/'probe_service.py')])
    if args.dry_run:
        print(json.dumps({'venv':str(env), 'commands':plan},ensure_ascii=False,indent=2));return
    if not python.exists(): venv.EnvBuilder(with_pip=True,system_site_packages=args.reuse_system_packages).create(env)
    if args.reuse_system_packages:
        check=subprocess.run([str(python),str(ROOT/'probe_service.py')],cwd=ROOT,capture_output=True,text=True)
        try:adopt=json.loads(check.stdout.splitlines()[-1]).get('ready',False)
        except (ValueError,IndexError):adopt=False
        if adopt:
            try:
                from importlib.metadata import version
                from packaging.requirements import Requirement
                for line in (ROOT/'requirements.txt').read_text().splitlines():
                    if not line.strip() or line.lstrip().startswith('#'):continue
                    requirement=Requirement(line)
                    if requirement.marker and not requirement.marker.evaluate():continue
                    if requirement.specifier and not requirement.specifier.contains(version(requirement.name),prereleases=True):adopt=False
            except Exception:adopt=False
        if adopt:plan=[command for command in plan if command[1:4]!=['-m','pip','install']]
    for command in plan: subprocess.run(command,check=True,cwd=ROOT)
    result=subprocess.run([str(python),str(ROOT/'probe_service.py')],cwd=ROOT,capture_output=True,text=True,check=True)
    state=json.loads(result.stdout.splitlines()[-1])
    if not state.get('ready'):raise SystemExit('Worker setup incomplete: '+str(state.get('missing')))
    marker=env/'worker-ready.json';temporary=env/'worker-ready.json.part'
    temporary.write_text(json.dumps({'requirementsHash':args.requirements_id,'python':str(python)}));temporary.replace(marker)
    print('Worker environment installed. ModelScope weights are downloaded by --download-model; recognition reads local paths without hub authentication.')

if __name__ == '__main__': main()
