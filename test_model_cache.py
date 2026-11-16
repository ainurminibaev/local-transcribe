import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import model_cache

class ModelCacheTests(unittest.TestCase):
    def test_missing_model_is_an_actionable_offline_error(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path,'home',return_value=Path(tmp)), patch.dict('os.environ',{},clear=True):
            with self.assertRaisesRegex(FileNotFoundError,'setup_worker.py'):
                model_cache.resolve_model('test/missing')

    def test_incomplete_download_is_not_ready(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path,'home',return_value=Path(tmp)), patch.dict('os.environ',{},clear=True):
            root=Path(tmp)/'.cache/modelscope/hub/models/test/model';root.mkdir(parents=True)
            (root/'configuration.json').write_text(json.dumps({'model_file':'missing.bin'}))
            with self.assertRaises(FileNotFoundError):model_cache.resolve_model('test/model')
            (root/'missing.bin').write_bytes(b'weights')
            self.assertEqual(model_cache.resolve_model('test/model'),str(root))

    def test_cached_children_are_local_paths(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path,'home',return_value=Path(tmp)), patch.dict('os.environ',{},clear=True):
            root=Path(tmp)/'.cache/modelscope/hub/models'
            top=root/model_cache.DIARIZATION_MODEL;top.mkdir(parents=True)
            (top/'configuration.json').write_text(json.dumps({'model':{'speaker_model':'test/speaker','vad_model':'test/vad','change_locator':'test/change'}}))
            for name in ['speaker','vad','change']:
                child=root/'test'/name;child.mkdir(parents=True);(child/'configuration.json').write_text('{}')
            path,children=model_cache.prepare_models()
            self.assertEqual(path,str(top));self.assertTrue(all(Path(p).is_absolute() for p in children.values()))
            self.assertEqual(set(children),{'speaker_model','vad_model','change_locator'})

if __name__=='__main__':unittest.main()
