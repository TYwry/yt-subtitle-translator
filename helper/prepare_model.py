"""第一次安裝時準備語音模型：電腦上已有 VoiceType 的 large-v3 就直接共用，否則下載 large-v3-turbo（約 1.6GB）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_config  # noqa: E402
from transcribe import pick_model  # noqa: E402

name, cache = pick_model(load_config())
from faster_whisper.utils import download_model  # noqa: E402

try:
    download_model(name, cache_dir=cache, local_files_only=True)
    print(f"語音模型 {name} 已存在，直接使用。")
except Exception:
    print(f"下載語音模型 {name}（只需一次）...")
    os.makedirs(cache, exist_ok=True)
    download_model(name, cache_dir=cache)
    print("語音模型下載完成。")

