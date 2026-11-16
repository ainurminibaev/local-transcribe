"""GigaAM GGUF из кэша Handy; загрузка через официальный transcribe.cpp."""
import glob
import os
from pathlib import Path

import numpy as np


def resolve_model(config):
    """Находим локальную модель, ничего не скачивая и не меняя в Handy."""
    pattern = os.path.expanduser(config["gguf_model"])
    paths = [Path(p) for p in glob.glob(pattern) if Path(p).is_file()]
    if not paths:
        raise FileNotFoundError(
            f"GigaAM GGUF не найдена: {pattern}. Скачайте модель в Handy "
            "или задайте gigaam.gguf_model в config.json."
        )
    return str(max(paths, key=lambda p: (p.stat().st_mtime_ns, str(p))))


def tokens(audio, chunks, config, sample_rate=16000):
    """Возвращаем совместимые с diarize.merge токены и абсолютные таймкоды."""
    model_path = resolve_model(config)
    import transcribe_cpp

    pieces, timed = {}, []
    with transcribe_cpp.Model(model_path) as model:
        with model.session() as session:
            for start, end in chunks:
                if end - start < 320:
                    continue
                pcm = np.ascontiguousarray(audio[start:end], dtype=np.float32)
                result = session.run(pcm, timestamps="token")
                if result.text.strip() and not result.tokens:
                    raise RuntimeError("GigaAM GGUF не вернула таймкоды токенов")
                first = True
                for token in result.tokens:
                    if not token.text:
                        continue
                    if token.t0_ms < 0 or token.t1_ms < token.t0_ms:
                        raise RuntimeError("GigaAM GGUF вернула некорректный таймкод")
                    index = len(pieces)
                    # Каждый чанк декодируется независимо: сохраняем границу слов.
                    pieces[index] = (" " if first else "") + token.text
                    first = False
                    midpoint = (token.t0_ms + token.t1_ms) / 2000.0
                    timed.append((start / sample_rate + midpoint, index))
    return pieces, -1, timed
