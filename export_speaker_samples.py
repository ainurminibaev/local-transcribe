"""Export anonymous audio examples for reviewing diarization, without naming people."""
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile


def export_samples(source,diarization,target):
    data=json.loads(Path(diarization).read_text());groups={}
    for segment in data['speakerSegments']:
        if segment['end']-segment['start']>=.8:
            groups.setdefault(segment['speaker'],[]).append(segment)
    index=[]
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp)
        for speaker,segments in sorted(groups.items()):
            for number,segment in enumerate(sorted(segments,key=lambda s:s['end']-s['start'],reverse=True)[:3],1):
                duration=min(8.,segment['end']-segment['start']);start=segment['start']
                relative=f'speaker-{speaker:02d}/sample-{number}.m4a';out=root/relative;out.parent.mkdir(parents=True,exist_ok=True)
                subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-n','-ss',str(start),'-i',str(source),'-t',str(duration),'-vn','-c:a','aac','-b:a','96k',str(out)],check=True)
                index.append({'speaker':speaker,'start':start,'end':start+duration,'file':relative})
        (root/'index.json').write_text(json.dumps({'identityLabels':False,'samples':index},ensure_ascii=False,indent=2)+'\n')
        with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED) as archive:
            for path in root.rglob('*'):
                if path.is_file():archive.write(path,path.relative_to(root))
    return index
