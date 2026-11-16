#!/usr/bin/env python3
"""Signal processing worker: recognition, diarization and requested audio assets."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input');ap.add_argument('--out-dir',required=True)
    ap.add_argument('--engine',choices=['gigaam','whisper'],default='gigaam')
    ap.add_argument('--no-speakers',action='store_true')
    ap.add_argument('--audio',action='store_true')
    ap.add_argument('--segments',action='store_true')
    ap.add_argument('--speaker-count',type=int)
    ap.add_argument('--samples',action='store_true')
    ap.add_argument('--lease-file');ap.add_argument('--lease-token')
    args=ap.parse_args()
    if args.no_speakers and (args.samples or args.speaker_count):ap.error('Speaker count/samples require diarization')
    if bool(args.lease_file)!=bool(args.lease_token):raise SystemExit('Both lease-file and lease-token are required')
    if args.lease_file:
        from lease_guard import supervise
        command=[sys.executable,str(Path(__file__).resolve()),args.input,'--out-dir',args.out_dir,'--engine',args.engine]
        if args.no_speakers:command.append('--no-speakers')
        if args.audio:command.append('--audio')
        if args.segments:command.append('--segments')
        if args.samples:command.append('--samples')
        if args.speaker_count:command+=['--speaker-count',str(args.speaker_count)]
        raise SystemExit(supervise(command,args.lease_file,args.lease_token))
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    source=Path(args.input).resolve();recognition_input=source
    artifacts={'transcript':str(out/'transcript.txt')}
    if args.audio:
        audio=out/'audio.m4a'
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-n','-i',str(source),'-vn','-c:a','aac','-b:a','96k',str(audio)],check=True)
        artifacts['audio']=str(audio);recognition_input=audio
    script='transcribe.py' if args.no_speakers else 'diarize_ms.py'
    command=[sys.executable,str(ROOT/script),str(recognition_input),'--out',artifacts['transcript']]
    if args.no_speakers:command+=['--engine',args.engine]
    elif args.engine!='gigaam':raise SystemExit('The speaker worker requires GigaAM')
    if not args.no_speakers:
        command+=['--json-out',str(out/'diarization.json'),'--cache-dir',str(out)]
        if args.speaker_count:command+=['--speaker-count',str(args.speaker_count)]
    subprocess.run(command,check=True)
    if args.segments or not args.no_speakers:
        artifacts['segments']=str(out/'diarization.json')
        if args.no_speakers:
            probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(source)],capture_output=True,text=True,check=True)
            duration=float(json.loads(probe.stdout)['format']['duration'])
            Path(artifacts['segments']).write_text(json.dumps({'text':Path(artifacts['transcript']).read_text(),'duration':duration,'speakerSegments':[],'speakerLabels':False},ensure_ascii=False,indent=2)+'\n')
    if args.samples:
        if args.no_speakers:raise SystemExit('Speaker samples require diarization')
        from worker_progress import progress
        progress(out,'speaker-samples')
        from export_speaker_samples import export_samples
        export_samples(source,out/'diarization.json',out/'speaker-samples.zip')
        artifacts['samples']=str(out/'speaker-samples.zip')
    diagnostics={}
    if not args.no_speakers:
        raw=json.loads((out/'diarization.json').read_text())
        diagnostics={key:raw.get(key) for key in ['detectedSpeakerClusters','speakerCountConstraint','warnings']}
        diagnostics['method']='normalized-kmeans' if args.speaker_count else 'modelscope-auto'
        diagnostics['identityLabels']=False
    (out/'result.json').write_text(json.dumps({'artifacts':artifacts,'engine':args.engine,'speakerLabels':not args.no_speakers,'diagnostics':diagnostics},ensure_ascii=False,indent=2)+'\n')
    from worker_progress import progress
    progress(out,'completed')
    print('OK -> '+str(out/'result.json'))

if __name__=='__main__':main()
