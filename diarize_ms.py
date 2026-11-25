#!/usr/bin/env python3
"""
Транскрипт СО СПИКЕРАМИ — готовый стек, без токенов:
  ModelScope 3D-Speaker (VAD + сегментация + CAM++ эмбеддинги + кластеризация,
  модели тянутся с ModelScope, PyTorch/MPS) -> интервалы спикеров;
  GigaAM (CTC) -> текст с таймкодами; склейка по времени.

Одноразовый процесс: модели в RAM -> отработал -> вышел -> RAM свободна.
Handy не трогаем. HuggingFace-токен не нужен.

  python3 diarize_ms.py <audio> [--out transcript.txt]
"""
import sys, os, time, argparse, json, subprocess
os.environ.setdefault("MODELSCOPE_LOG_LEVEL", "40")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import diarize as D


def diarize_ms(wav, audio, speaker_count=None, cache_dir=None):
    from modelscope.pipelines import pipeline
    from modelscope.utils.constant import Tasks
    from modelscope.models import Model
    from model_cache import prepare_models
    model_path, child_paths = prepare_models()
    model = Model.from_pretrained(model_path, **child_paths)
    sd = pipeline(task=Tasks.speaker_diarization, model=model)
    import torch
    # ModelScope's device parser knows CUDA/CPU but not Apple MPS. Move the
    # embedding model and its input device explicitly, without patching packages.
    device = ('mps' if torch.backends.mps.is_available() else
              'cuda' if torch.cuda.is_available() else 'cpu')
    speaker_model = sd.sv_pipeline.model
    speaker_model.device = torch.device(device)
    speaker_model.embedding_model.to(speaker_model.device)
    sys.stderr.write(f'[diarize_ms] speaker embeddings device: {device}\n')
    from diarization_cache import diarize
    result = diarize(sd,wav,audio,D.SR,speaker_count,cache_dir)
    return [(float(a), float(b), int(s)) for a,b,s in result]


def speaker_segments(wav, audio, speaker_count=None, cache_dir=None):
    helper = os.getenv("LOCAL_TRANSCRIBE_FLUIDAUDIO")
    warnings = []
    if helper:
        from fluidaudio_diarization import diarize
        try:
            return diarize(helper, wav, len(audio) / D.SR, speaker_count), "fluidaudio-offline", warnings
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
            sys.stderr.write(f"[diarize_ms] FluidAudio failed, using ModelScope: {error}\n")
            warnings.append("FluidAudio failed; used ModelScope")
    method = "normalized-kmeans" if speaker_count else "modelscope-auto"
    return diarize_ms(wav, audio, speaker_count, cache_dir), method, warnings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    ap.add_argument("--json-out", default=None)
    ap.add_argument("--speaker-count",type=int)
    ap.add_argument("--cache-dir")
    ap.add_argument("--vocabulary-file")
    args = ap.parse_args()
    if args.speaker_count is not None and not 1<=args.speaker_count<=32:ap.error("speaker-count must be between 1 and 32")

    wav = D.to_wav(args.audio)
    try:
        import soundfile as sf
        y, _ = sf.read(wav, dtype="float32")
        if y.ndim > 1: y = y.mean(axis=1)
        sys.stderr.write("[diarize_ms] диаризация...\n")
        from worker_progress import progress
        progress(args.cache_dir,'diarization',duration=len(y)/D.SR)
        t0 = time.time()
        segs, method, warnings = speaker_segments(wav, y, args.speaker_count, args.cache_dir)
        segs.sort()
        sys.stderr.write(f"[diarize_ms] {method}, спикеров: {len(set(s for *_, s in segs))}, "
                         f"сегментов: {len(segs)}, {round(time.time()-t0,1)} с\n")
        progress(args.cache_dir,'asr',detectedSpeakerClusters=len({speaker for _,_,speaker in segs}))
        sys.stderr.write(f"[diarize_ms] распознавание GigaAM ({D.CFG['gigaam'].get('backend', 'onnx')})...\n")
        from pathlib import Path
        from diarization_cache import audio_fingerprint
        vocabulary = json.loads(Path(args.vocabulary_file).read_text()) if args.vocabulary_file else []
        cache=Path(args.cache_dir)/'asr-tokens-v2.json' if args.cache_dir else None
        fingerprint=audio_fingerprint(y)
        import hashlib
        vocabulary_digest = hashlib.sha256(json.dumps(vocabulary, ensure_ascii=False).encode()).hexdigest()
        if cache and cache.is_file():
            data=json.loads(cache.read_text())
            if (data['audioSha256'], data['config'], data.get('vocabularySha256')) != (fingerprint, D.CFG['gigaam'], vocabulary_digest):
                raise ValueError('ASR cache does not match this recording/configuration')
            id2tok={int(k):v for k,v in data['pieces'].items()};toks=data['tokens']
            sys.stderr.write('[diarize_ms] reuse cached ASR tokens\n')
        else:
            id2tok, _, toks = D.gigaam_tokens(y, vocabulary)
            if cache:
                cache.parent.mkdir(parents=True,exist_ok=True)
                temporary=cache.with_suffix('.json.part')
                temporary.write_text(json.dumps({'audioSha256':fingerprint,'vocabularySha256':vocabulary_digest,'config':D.CFG['gigaam'],'pieces':id2tok,'tokens':toks},ensure_ascii=False,default=lambda value:value.item()))
                temporary.replace(cache)
        words = list(D.timed_words(id2tok, toks))
        turns = D.word_turns(segs, words)
        gaps = D.transcript_gaps(words, segs, len(y) / D.SR)
        text = D.render_transcript(turns, gaps)
        nspk = len({turn["speaker"] for turn in turns if turn["speaker"] is not None})
    finally:
        os.remove(wav)

    if args.json_out:
        payload={'duration':len(y)/D.SR,'detectedSpeakerClusters':len({speaker for _,_,speaker in segs}),'speakerCountConstraint':args.speaker_count,'identityLabels':False,'speakerLabels':True,'text':text,
                 'speakerSegments':[{'start':float(start),'end':float(end),'speaker':int(speaker)} for start,end,speaker in segs],
                 'turns':turns,'transcriptGaps':gaps,'method':method,'warnings':warnings }
        if args.speaker_count and payload['detectedSpeakerClusters']!=args.speaker_count:
            payload['warnings'].append('Detected speaker count differs from the constraint; review samples before assigning identities')
        with open(args.json_out,'w',encoding='utf-8') as out:
            json.dump(payload,out,ensure_ascii=False,indent=2);out.write('\n')

    if args.out:
        open(args.out, "w", encoding="utf-8").write(text + "\n")
        print(f"OK -> {args.out} ({nspk} спикеров, {len(text)} символов)")
    else:
        print(text)


if __name__ == "__main__":
    main()
