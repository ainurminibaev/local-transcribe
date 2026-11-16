import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import download_modelscope as downloader

class Response:
    def __init__(self,data):self.data=data
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def raise_for_status(self):pass
    def iter_content(self,size):return iter([self.data])

class ModelDownloadTests(unittest.TestCase):
    def setup_manifest(self,root,content):
        path=root/'manifest.json';path.write_text(json.dumps({'models':{'test/model':{'revision':'pinned','files':{'weights.bin':hashlib.sha256(content).hexdigest()}}}}));return path
    def test_verified_file_is_reused_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest=self.setup_manifest(root,b'weights');dest=root/'cache';dest.mkdir();(dest/'weights.bin').write_bytes(b'weights')
            with patch.object(downloader,'MANIFEST',manifest),patch('requests.get') as get:
                downloader.download_model('test/model',dest);get.assert_not_called()
    def test_public_download_is_verified_and_atomically_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest=self.setup_manifest(root,b'weights');dest=root/'cache'
            with patch.object(downloader,'MANIFEST',manifest),patch('requests.get',return_value=Response(b'weights')):
                downloader.download_model('test/model',dest)
            self.assertEqual((dest/'weights.bin').read_bytes(),b'weights');self.assertEqual(len(list(dest.iterdir())),1)
    def test_bad_checksum_does_not_replace_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest=self.setup_manifest(root,b'weights');dest=root/'cache';dest.mkdir();(dest/'weights.bin').write_bytes(b'previous')
            with patch.object(downloader,'MANIFEST',manifest),patch('requests.get',return_value=Response(b'corrupted')):
                with self.assertRaisesRegex(ValueError,'checksum mismatch'):downloader.download_model('test/model',dest)
            self.assertEqual((dest/'weights.bin').read_bytes(),b'previous');self.assertEqual(len(list(dest.iterdir())),1)

if __name__=='__main__':unittest.main()
