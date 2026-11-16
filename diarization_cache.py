"""Reusable acoustic features and bounded clustering with a known speaker count."""
import hashlib
import os
from pathlib import Path
import numpy as np


def audio_fingerprint(audio):
    return hashlib.sha256(memoryview(np.ascontiguousarray(audio)).cast('B')).hexdigest()


def fixed_clusters(embeddings,count):
    from sklearn.cluster import KMeans
    from threadpoolctl import threadpool_limits
    if len(embeddings)<count:raise ValueError('Too few speech windows for the requested speaker count')
    if count==1:return np.zeros(len(embeddings),dtype=int)
    normalized=embeddings/np.maximum(np.linalg.norm(embeddings,axis=1,keepdims=True),1e-12)
    with threadpool_limits(limits=min(os.cpu_count() or 1,4)):
        return KMeans(n_clusters=count,n_init=10,random_state=0).fit_predict(normalized)


def diarize(pipeline,wav,audio,sample_rate,speaker_count=None,cache_dir=None):
    fingerprint=audio_fingerprint(audio)
    if speaker_count is not None:
        # No dense N×N spectral matrix for long recordings.
        pipeline.clustering=lambda embeddings:fixed_clusters(embeddings,speaker_count)
    cache=Path(cache_dir)/'speaker-features.npz' if cache_dir else None
    if cache and cache.is_file():
        with np.load(cache,allow_pickle=False) as data:
            if str(data['audioSha256'])!=fingerprint:raise ValueError('Diarization cache belongs to another recording')
            embeddings=data['embeddings'];bounds=data['bounds'];vad_bounds=data['vadBounds']
        segments=[[float(a),float(b),audio[int(a*sample_rate):int(b*sample_rate)]] for a,b in bounds]
        vad=[[float(a),float(b),audio[int(a*sample_rate):int(b*sample_rate)]] for a,b in vad_bounds]
        labels=pipeline.clustering(embeddings)
        return pipeline.postprocess(segments,vad,labels,embeddings)
    collected={}
    preprocess,forward=pipeline.preprocess,pipeline.forward
    def capture_vad(value):
        result=preprocess(value);collected['vadBounds']=np.asarray([[a,b] for a,b,*_ in result],dtype=float);return result
    def capture_embeddings(segments):
        result=forward(segments);collected['bounds']=np.asarray([[a,b] for a,b,*_ in segments],dtype=float)
        collected['embeddings']=result;return result
    pipeline.preprocess=capture_vad;pipeline.forward=capture_embeddings
    try:result=pipeline(wav)['text']
    finally:pipeline.preprocess=preprocess;pipeline.forward=forward
    if cache:
        cache.parent.mkdir(parents=True,exist_ok=True)
        temporary=cache.with_suffix('.npz.part')
        with temporary.open('wb') as out:np.savez_compressed(out,audioSha256=np.asarray(fingerprint),**collected)
        temporary.replace(cache)
    return result
