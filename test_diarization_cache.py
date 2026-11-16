from pathlib import Path
import tempfile
import unittest
import numpy as np
from diarization_cache import diarize,fixed_clusters

class FakePipeline:
    def __init__(self):self.calls=0
    def preprocess(self,value):return [[0.,1.,np.zeros(100)],[1.,2.,np.zeros(100)]]
    def forward(self,segments):self.calls+=1;return np.array([[1.,0.],[0.,1.]])
    def clustering(self,embeddings):return np.zeros(len(embeddings),dtype=int)
    def postprocess(self,segments,vad,labels,embeddings):return [(s[0],s[1],int(label)) for s,label in zip(segments,labels)]
    def __call__(self,value):
        segments=self.preprocess(value);features=self.forward(segments)
        return {'text':self.postprocess(segments,segments,self.clustering(features),features)}

class DiarizationCacheTests(unittest.TestCase):
    def test_known_count_preserves_a_separable_minority_voice(self):
        rng=np.random.default_rng(7);points=[];expected=[]
        for speaker,size in enumerate([100,100,100,100,8]):
            center=np.eye(5)[speaker]
            points.append(center+rng.normal(scale=.02,size=(size,5)));expected.extend([speaker]*size)
        labels=fixed_clusters(np.vstack(points),5)
        from sklearn.metrics import adjusted_rand_score
        self.assertEqual(len(set(labels)),5);self.assertGreater(adjusted_rand_score(expected,labels),.99)

    def test_reclustering_reuses_features_without_recomputing_embeddings(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio=np.zeros(200,dtype=np.float32);first=FakePipeline()
            diarize(first,'unused',audio,100,cache_dir=tmp);self.assertEqual(first.calls,1)
            second=FakePipeline();result=diarize(second,'unused',audio,100,speaker_count=2,cache_dir=tmp)
            self.assertEqual(second.calls,0);self.assertEqual(len({row[2] for row in result}),2)

    def test_cache_cannot_be_reused_for_another_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            diarize(FakePipeline(),'unused',np.zeros(200,dtype=np.float32),100,cache_dir=tmp)
            with self.assertRaisesRegex(ValueError,'another recording'):
                diarize(FakePipeline(),'unused',np.ones(200,dtype=np.float32),100,cache_dir=tmp)

if __name__=='__main__':unittest.main()
