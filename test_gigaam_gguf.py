"""Проверки адаптера GGUF без загрузки модели и доступа к сети."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import gigaam_gguf
import diarize


class GigaamGgufTests(unittest.TestCase):
    def test_missing_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                gigaam_gguf.resolve_model({"gguf_model": tmp + "/*.gguf"})

    def test_model_discovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "model.gguf"
            model.write_bytes(b"test")
            self.assertEqual(gigaam_gguf.resolve_model({"gguf_model": tmp + "/*.gguf"}), str(model))

    def run_mock(self, results):
        module = MagicMock()
        session = module.Model.return_value.__enter__.return_value.session.return_value.__enter__.return_value
        session.run.side_effect = results
        with patch.dict("sys.modules", {"transcribe_cpp": module}), patch.object(gigaam_gguf, "resolve_model", return_value="model.gguf"):
            return gigaam_gguf.tokens(np.zeros(64000, dtype=np.float32), [(0, 32000), (32000, 64000)], {})

    def test_chunk_offsets_and_speakers(self):
        results = [SimpleNamespace(text=text, tokens=[SimpleNamespace(text=text, t0_ms=100, t1_ms=300)]) for text in ["Привет", "Пока"]]
        pieces, blank, timed = self.run_mock(results)
        self.assertEqual(blank, -1)
        self.assertEqual(timed, [(0.2, 0), (2.2, 1)])
        self.assertEqual("".join(pieces.values()).strip(), "Привет Пока")
        text = diarize.merge([(0, 2, 0), (2, 4, 1)], pieces, timed, 0)
        self.assertEqual(text, "Speaker 0 [00:00]: Привет\nSpeaker 1 [00:02]: Пока")

    def test_missing_timestamps_fail(self):
        with self.assertRaises(RuntimeError):
            self.run_mock([SimpleNamespace(text="Привет", tokens=[])])

    def test_invalid_timestamps_fail(self):
        result = SimpleNamespace(text="Привет", tokens=[SimpleNamespace(text="Привет", t0_ms=-1, t1_ms=10)])
        with self.assertRaises(RuntimeError):
            self.run_mock([result])

    def test_onnx_route_preserved(self):
        with patch.dict(diarize.CFG["gigaam"], {"backend": "onnx"}), patch("builtins.open", side_effect=FileNotFoundError("legacy vocab")):
            with self.assertRaisesRegex(FileNotFoundError, "legacy vocab"):
                diarize.gigaam_tokens(np.zeros(320, dtype=np.float32))


if __name__ == "__main__":
    unittest.main()
