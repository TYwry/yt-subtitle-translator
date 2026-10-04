"""共用設定：路徑、設定檔、金鑰加密、記錄檔。"""
import ctypes
import json
import logging
import logging.handlers
import os
import secrets
import sys

APP_NAME = "YT 字幕助手"
VERSION = "1.2.1"
HELPER_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(HELPER_DIR)
CONFIG_PATH = os.path.join(HELPER_DIR, "config.json")
CACHE_DIR = os.path.join(HELPER_DIR, "cache")
TMP_DIR = os.path.join(HELPER_DIR, "tmp")
LOG_PATH = os.path.join(HELPER_DIR, "helper.log")
OWN_MODEL_DIR = os.path.join(HELPER_DIR, "models")
# 同一台電腦上的 VoiceType（若有）：可共用已下載的語音模型與顯示卡元件
VOICETYPE_DIR = os.path.join(os.path.dirname(PROJECT_DIR), "VoiceType")

# 擴充功能的固定 ID（由 manifest.json 裡的 key 決定）；只有它可以呼叫本機助手
EXTENSION_ID = "bkhhpabcfpnobbkoadaalpagjdcdjmec"
NATIVE_HOST_NAME = "com.ty.ytsub_helper"

DEFAULTS = {
    "port": 8765,
    "token": "",
    "groq_key_enc": "",
    "groq_model": "openai/gpt-oss-120b",
    "whisper_model": "",      # 空白 = 自動（有 VoiceType 的 large-v3 就共用，否則用 large-v3-turbo）
    "cache_days": 30,
    "autostart": False,
}

GROQ_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]


def purge_old_log_lines():
    """記錄檔裡有看過的影片代碼（等同觀看紀錄），依「快取保留天數」刪掉太舊的行。"""
    import datetime as _dt
    data = load_json(CONFIG_PATH, {})
    try:
        days = int(data.get("cache_days", DEFAULTS["cache_days"]) if isinstance(data, dict) else DEFAULTS["cache_days"])
    except (TypeError, ValueError):
        days = DEFAULTS["cache_days"]
    if days <= 0:
        return
    cutoff = (_dt.datetime.now() - _dt.timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    for path in (LOG_PATH, LOG_PATH + ".1"):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            keep, keeping = [], False
            for ln in lines:
                if len(ln) >= 19 and ln[4] == "-" and ln[10] == " " and ln[13] == ":":
                    keeping = ln[:19] >= cutoff
                if keeping:
                    keep.append(ln)
            if len(keep) != len(lines):
                with open(path, "w", encoding="utf-8") as f:
                    f.writelines(keep)
        except OSError:
            pass


def ascii_path(path):
    """語音模型程式在 Windows 讀不了含中文或特殊字元的路徑：改用 Windows 的短路徑（8.3 格式）。"""
    if path.isascii() or os.name != "nt":
        return path
    try:
        os.makedirs(path, exist_ok=True)
        buf = ctypes.create_unicode_buffer(1024)
        if ctypes.windll.kernel32.GetShortPathNameW(path, buf, 1024) and buf.value.isascii():
            return buf.value
    except Exception:
        pass
    return path


def setup_logging():
    purge_old_log_lines()
    h = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=1, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(h)
    if sys.stderr is not None:
        root.addHandler(logging.StreamHandler())


log = logging.getLogger("ytsub")


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_config():
    cfg = dict(DEFAULTS)
    data = load_json(CONFIG_PATH, None)
    if data is None and os.path.exists(CONFIG_PATH):
        # 設定檔壞掉：先備份起來，避免直接覆蓋掉（裡面可能有已加密的金鑰）
        try:
            os.replace(CONFIG_PATH, CONFIG_PATH + ".broken")
            log.warning("config.json 格式錯誤，已備份成 config.json.broken 並重建")
        except OSError:
            pass
    cfg.update(data if isinstance(data, dict) else {})
    if cfg.get("groq_model") not in GROQ_MODELS:
        cfg["groq_model"] = GROQ_MODELS[0]     # 舊設定裡已下架的模型改回預設
    if not cfg.get("token"):
        cfg["token"] = secrets.token_urlsafe(24)   # 本機通行碼：擴充功能每次呼叫都要附上
        save_json(CONFIG_PATH, cfg)
    return cfg


def save_config(cfg):
    save_json(CONFIG_PATH, cfg)


# ───────── 金鑰加密（Windows DPAPI：只有同一台電腦、同一個 Windows 帳號解得開） ─────────
if os.name == "nt":
    import ctypes.wintypes as wt

    class _BLOB(ctypes.Structure):
        _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data, protect, entropy):
    import base64
    if os.name != "nt":
        raise OSError("金鑰加密只支援 Windows")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    k32 = ctypes.WinDLL("kernel32")
    raw = data.encode("utf-8") if protect else base64.b64decode(data)
    buf = ctypes.create_string_buffer(raw, len(raw))
    blob_in = _BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    ebuf = ctypes.create_string_buffer(entropy, len(entropy))
    eblob = _BLOB(len(entropy), ctypes.cast(ebuf, ctypes.POINTER(ctypes.c_char)))
    out = _BLOB()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(blob_in), None, ctypes.byref(eblob), None, None, 0x1, ctypes.byref(out)):
        raise OSError(f"DPAPI 失敗（{ctypes.get_last_error()}）")
    try:
        res = ctypes.string_at(out.pbData, out.cbData)
    finally:
        k32.LocalFree(out.pbData)
    return base64.b64encode(res).decode("ascii") if protect else res.decode("utf-8")


_ENTROPY = b"YT subtitle helper key v1"


def encrypt_secret(text):
    return _dpapi(text, True, _ENTROPY)   # 失敗就報錯，絕不改存明文


def decrypt_secret(token):
    return _dpapi(token, False, _ENTROPY)


def clean_key(k):
    return "".join(ch for ch in (k or "") if ch.isalnum() or ch in "_-.")
