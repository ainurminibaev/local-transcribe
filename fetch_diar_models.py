#!/usr/bin/env python3
"""Скачивает onnx-модели для sherpa-onnx-диаризации (запасной путь `diarize.py`) в diar_models/.
Основной путь `diarize_ms.py` использует ModelScope и тянет модели сам в ~/.cache/modelscope —
этот скрипт для onnx-фолбэка без torch. Запуск: python3 fetch_diar_models.py"""
import os, ssl, tarfile, urllib.request
try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    CTX = ssl._create_unverified_context()
urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPSHandler(context=CTX)))

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "diar_models")
os.makedirs(D, exist_ok=True)
BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
FILES = {
    "embedding.onnx":      f"{BASE}/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    "campplus.onnx":       f"{BASE}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "eres2net_base.onnx":  f"{BASE}/speaker-recongition-models/3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx",
}
SEG = f"{BASE}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"

for name, url in FILES.items():
    dst = os.path.join(D, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 10000:
        print("есть:", name); continue
    print("качаю:", name); urllib.request.urlretrieve(url, dst)
    print("  ->", os.path.getsize(dst) // 1024 // 1024, "МБ")

seg_dir = os.path.join(D, "sherpa-onnx-pyannote-segmentation-3-0")
if not os.path.isdir(seg_dir):
    tarp = os.path.join(D, "seg.tar.bz2")
    print("качаю: сегментация pyannote"); urllib.request.urlretrieve(SEG, tarp)
    with tarfile.open(tarp, "r:bz2") as t:
        t.extractall(D)
    os.remove(tarp)
print("Готово. Модели в", D)
