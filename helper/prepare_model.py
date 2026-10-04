"""第一次安裝時準備語音模型：電腦上已有 VoiceType 的 large-v3 就直接共用，否則下載 large-v3-turbo（約 1.6GB）。
下載時每 3 秒顯示一次已下載的大小；網路中斷會自動重試並從中斷處接著下載。"""
import os
import sys
import threading
import time

# 用一般的下載方式（新版的 Xet 下載方式在部分 Windows 電腦上會卡住不動）；連線 60 秒沒資料就重試
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ascii_path, load_config  # noqa: E402
from transcribe import pick_model  # noqa: E402

from faster_whisper.utils import _MODELS, download_model  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402

name, cache = pick_model(load_config())
cache = ascii_path(cache)          # 跟本機助手載入模型時用同一個路徑
os.makedirs(cache, exist_ok=True)

try:
    download_model(name, cache_dir=cache, local_files_only=True)
    print(f"語音模型 {name} 已存在，直接使用。")
    sys.exit(0)
except Exception:
    pass

repo = name if "/" in name else _MODELS[name]
blobs = os.path.join(cache, "models--" + repo.replace("/", "--"), "blobs")
done = threading.Event()


def show_progress():
    """每 3 秒顯示一次已下載的大小，讓人知道沒有卡住（大檔案的進度條要等整個檔案下載完才會動）。"""
    last, still = -1, 0
    while not done.wait(3):
        size = 0
        try:
            for f in os.listdir(blobs):
                # 下載中的檔案在 Windows 上用 getsize 讀到的大小不會更新，要打開檔案看實際長度
                fp = os.path.abspath(os.path.join(blobs, f))
                if os.name == "nt" and len(fp) >= 240:
                    fp = "\\\\?\\" + fp         # 路徑太長時加上長路徑前綴
                with open(fp, "rb") as fh:
                    size += fh.seek(0, os.SEEK_END)
        except OSError:
            pass
        still = still + 1 if size == last else 0
        last = size
        note = "（網路好像停住了，會自動重試）" if still >= 20 else ""
        print(f"\r  已下載 {size / 1048576:,.0f} MB {note}      ", end="", flush=True)


print(f"下載語音模型 {name}（只需一次，約 1.5～3 GB）...")
print("請不要點黑色視窗裡面：點了會暫停，暫停時按 Esc 或 Enter 就會繼續。")
threading.Thread(target=show_progress, daemon=True).start()
for attempt in range(1, 6):
    try:
        # 跟 faster-whisper 下載的檔案一樣
        snapshot_download(repo, cache_dir=cache,
                          allow_patterns=["config.json", "preprocessor_config.json", "model.bin",
                                          "tokenizer.json", "vocabulary.*"])
        download_model(name, cache_dir=cache, local_files_only=True)   # 確認真的完整了
        done.set()
        print("\n語音模型下載完成。")
        break
    except KeyboardInterrupt:
        raise
    except Exception as e:
        if attempt == 5:
            done.set()
            print(f"\n語音模型下載失敗：{e}")
            print("請確認網路正常後，重新雙擊 start-helper.bat，會從中斷的地方繼續下載。")
            sys.exit(1)
        print(f"\n下載中斷（{e.__class__.__name__}），10 秒後自動重試（第 {attempt + 1}/5 次）...")
        time.sleep(10)
