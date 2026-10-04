"""語音辨識：用 yt-dlp 只下載影片聲音，再用 faster-whisper（顯示卡）辨識成有時間點的字幕。"""
import glob
import os
import re
import sys
import threading
import time

from common import OWN_MODEL_DIR, ascii_path, TMP_DIR, VOICETYPE_DIR, log

# 下載語音模型用一般的下載方式（新版的 Xet 下載方式在部分 Windows 電腦上會卡住不動）
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
# 「原文」可以指定的語言（全球使用人口最多的前十種）；空白 = 自動偵測
WHISPER_LANGS = {"en", "zh", "hi", "es", "ar", "fr", "bn", "pt", "ru", "id"}


# ───────── 讓 pip 安裝的 CUDA 元件（cuBLAS / cuDNN）被找到 ─────────
def setup_cuda_dlls():
    cands = [os.path.join(sys.prefix, "Lib", "site-packages", "nvidia"),
             os.path.join(VOICETYPE_DIR, ".venv", "Lib", "site-packages", "nvidia")]  # 共用 VoiceType 的
    for nv in cands:
        if not os.path.isdir(nv):
            continue
        for sub in os.listdir(nv):
            b = os.path.join(nv, sub, "bin")
            if os.path.isdir(b):
                try:
                    os.add_dll_directory(b)
                except Exception:
                    pass
                os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")


def patch_av():
    """新版 PyAV（15 版以後）拿掉了 metadata_errors 參數，但 faster-whisper 讀音檔時還會傳它，
    會出現「open() got an unexpected keyword argument 'metadata_errors'」。這裡讓它自動略過這個參數。"""
    try:
        import av
    except Exception:
        return
    if getattr(av.open, "_ytsub_patched", False):
        return
    orig = av.open

    def _open(*args, **kw):
        try:
            return orig(*args, **kw)
        except TypeError as e:
            if "metadata_errors" not in str(e):
                raise
            kw.pop("metadata_errors", None)
            return orig(*args, **kw)
    _open._ytsub_patched = True
    av.open = _open


def pick_model(cfg):
    """回傳 (模型名稱, 模型資料夾)。優先共用 VoiceType 已下載好的 large-v3。"""
    want = (cfg.get("whisper_model") or "").strip()
    vt_dir = os.path.join(VOICETYPE_DIR, "models")
    vt_has = lambda name: glob.glob(os.path.join(vt_dir, f"models--Systran--faster-whisper-{name}", "snapshots", "*", "model.bin"))
    if want:
        return want, (vt_dir if vt_has(want) else OWN_MODEL_DIR)
    if vt_has("large-v3"):
        return "large-v3", vt_dir
    return "large-v3-turbo", OWN_MODEL_DIR


def is_cuda_error(e):
    s = str(e).lower()
    return any(k in s for k in ("cuda", "cublas", "cudnn", "device-side", "out of memory"))


class Model:
    def __init__(self):
        self.model = None
        self.name = ""
        self.device = ""
        self.status = "尚未載入"
        self.ready = threading.Event()
        self.lock = threading.Lock()   # 顯示卡一次只做一件事

    def load(self, cfg):
        self.ready.clear()
        try:
            setup_cuda_dlls()
            patch_av()
            from faster_whisper import WhisperModel
            from faster_whisper.utils import download_model
            name, cache = pick_model(cfg)
            cache = ascii_path(cache)
            os.makedirs(cache, exist_ok=True)
            try:
                path = download_model(name, cache_dir=cache, local_files_only=True)
            except Exception:
                self.status = f"下載語音模型 {name}（只需一次）…"
                path = download_model(name, cache_dir=cache)
            last = None
            for dev, ct in (("cuda", "float16"), ("cuda", "int8_float16"), ("cuda", "int8"), ("cpu", "int8")):
                try:
                    self.status = f"載入語音模型（{dev}）…"
                    m = WhisperModel(path, device=dev, compute_type=ct)
                    import numpy as np
                    list(m.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1, language="en")[0])  # 暖機兼確認可用
                    self.model, self.name, self.device = m, name, dev
                    self.status = f"{name} · {'顯示卡' if dev == 'cuda' else 'CPU（較慢）'} · 就緒"
                    log.info("model loaded %s %s %s", name, dev, ct)
                    break
                except Exception as e:
                    last = e
                    log.warning("load %s %s %s failed: %s", name, dev, ct, e)
            if self.model is None:
                self.status = f"語音模型載入失敗：{last}"
        except Exception as e:
            log.exception("model load")
            self.status = f"語音模型載入失敗：{e}"
        finally:
            self.ready.set()


# ───────── 下載聲音 ─────────
def download_audio(video_id, on_progress, should_stop):
    if not VIDEO_ID_RE.match(video_id):
        raise ValueError("影片代碼格式不正確")
    import yt_dlp
    os.makedirs(TMP_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(TMP_DIR, video_id + ".*")):
        try:
            os.remove(old)
        except OSError:
            pass

    def hook(d):
        if should_stop():
            raise yt_dlp.utils.DownloadCancelled("cancelled")
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                on_progress(d.get("downloaded_bytes", 0) / total)

    opts = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": os.path.join(TMP_DIR, "%(id)s.%(ext)s"),
        "quiet": True, "no_warnings": True, "noprogress": True,
        "noplaylist": True, "progress_hooks": [hook],
        "retries": 3, "socket_timeout": 30,
    }
    deno = os.path.join(sys.prefix, "Scripts", "deno.exe")
    if os.path.exists(deno):
        opts["js_runtimes"] = {"deno": {"path": deno}}
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info.get("is_live"):
            raise RuntimeError("直播影片無法預先辨識")
        files = glob.glob(os.path.join(TMP_DIR, video_id + ".*"))
        files = [f for f in files if not f.endswith((".part", ".ytdl"))]
        if not files:
            raise RuntimeError("聲音下載失敗")
        return files[0], float(info.get("duration") or 0)


# ───────── 把辨識結果切成適合閱讀的字幕 ─────────
HALLU = ["Amara.org", "明鏡與點點", "請不吝點贊訂閱", "字幕由", "ご視聴ありがとうございました"]
_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
_END = tuple(".?!。？！…")


def _width(s):
    return sum(2 if _CJK.match(c) else 1 for c in s)


_CLAUSE = tuple(",;:，；：、")
_CLOSERS = "\"'”’」』)）]"


def _ends_sentence(txt):
    return txt.rstrip(_CLOSERS).endswith(_END)


def _join(a, b):
    if not a:
        return b
    sep = "" if (_CJK.match(a[-1]) and _CJK.match(b[:1] or "a")) else " "
    return a + sep + b


LINE_WIDTH = 70     # 一則字幕的長度上限（英文約 70 個字母、中日韓約 35 個字），翻譯後在播放器上大多能放進一行
LINE_DUR = 6.0      # 一則字幕最長幾秒


def split_long(s, e, t, max_width=LINE_WIDTH):
    """太長的字幕切成兩半（遞迴），優先切在逗號、句號等標點後面，其次切在空白處；時間依字數比例分配。"""
    total = _width(t)
    if total <= max_width * 1.15:
        return [(s, e, t)]
    best, best_score = None, None
    acc = 0
    for i, ch in enumerate(t[:-1]):
        acc += 2 if _CJK.match(ch) else 1
        nxt = t[i + 1]
        if not (ch == " " or _CJK.match(ch) or _CJK.match(nxt) or ch in _CLAUSE or ch in _END):
            continue                       # 不要切在英文單字中間
        score = abs(acc - total / 2)
        if ch in _CLAUSE or ch in _END or (ch == " " and t[i - 1:i] in _CLAUSE + _END):
            score -= total * 0.2           # 標點的地方比較自然
        if best_score is None or score < best_score:
            best, best_score = i + 1, score
    if not best:
        return [(s, e, t)]
    a, b = t[:best].strip(), t[best:].strip()
    if not a or not b:
        return [(s, e, t)]
    mid = s + (e - s) * _width(a) / max(1, _width(a) + _width(b))
    return split_long(s, mid, a, max_width) + split_long(mid, e, b, max_width)


def segments_to_cues(seg, max_width=LINE_WIDTH, max_dur=LINE_DUR, gap=0.9):
    """把一段 whisper 結果依「句子」切成字幕：同一個人講的一整句放在同一則（上下兩行才對得起來）。
    停頓超過 gap 秒（通常是換人或換話題）一定切開；句子太長時才切，而且優先切在逗號等子句的地方。
    回傳 [(開始, 結束, 文字)]。"""
    words = [w for w in (seg.words or []) if w.word.strip()]
    if not words:
        t = seg.text.strip()
        return [(seg.start, seg.end, t)] if t else []
    cues, cur = [], []   # cur: 目前這句的字索引

    def emit(idx):
        txt = re.sub(r"^(>>|[-–—])\s*", "", "".join(words[i].word for i in idx).strip())   # 去掉換人記號
        if txt:
            cues.append((words[idx[0]].start, words[idx[-1]].end, txt))

    for i, w in enumerate(words):
        if cur and w.start - words[cur[-1]].end >= gap:
            emit(cur)
            cur = []
        # Whisper 有時會用「- 」或「>>」標出對話換人：一定斷開
        if cur and w.word.strip().startswith(("-", ">>", "–", "—")) and len(w.word.strip()) <= 3:
            emit(cur)
            cur = []
        cur.append(i)
        txt = "".join(words[j].word for j in cur).strip()
        dur = words[cur[-1]].end - words[cur[0]].start
        if _ends_sentence(txt) and dur >= 1.2:
            emit(cur)
            cur = []
        elif _width(txt) >= max_width or dur >= max_dur:
            cut = None
            for k in range(len(cur) - 2, len(cur) // 3 - 1, -1):
                if words[cur[k]].word.strip().endswith(_CLAUSE):
                    cut = k
                    break
            if cut is None:
                emit(cur)
                cur = []
            else:
                emit(cur[:cut + 1])
                cur = cur[cut + 1:]
    if cur:
        emit(cur)
    return cues


def _norm(item):
    """字幕項目統一成 (開始, 結束, 文字, 說話者, 是否換人開頭)。"""
    s, e, t = item[0], item[1], item[2]
    p = item[3] if len(item) > 3 else None
    turn = item[4] if len(item) > 4 else False
    return s, e, t, p, turn


class SentenceMerger:
    """把被切斷的字幕片段接回完整的句子（YouTube 字幕與 Whisper 的分段常常切在句子中間）。
    標記為換人說話的片段，絕對不會被接在一起。
    feed() 回傳已經是完整句子的字幕 (開始, 結束, 文字)；最後要呼叫 flush() 取出剩下的。"""

    def __init__(self, max_width=LINE_WIDTH, max_dur=LINE_DUR, gap=1.5):
        self.max_width, self.max_dur, self.gap = max_width, max_dur, gap
        self.buf = None   # [start, end, text, _]

    def feed(self, items):
        out = []
        for item in items:
            s, e, t, p, turn = _norm(item)
            t = " ".join(t.split())
            if not t:
                continue
            b = self.buf
            if b and (turn or s - b[1] > self.gap or _width(b[2]) + _width(t) > self.max_width * 1.15
                      or e - b[0] > self.max_dur * 1.3):
                out.append(tuple(b[:3]))
                b = self.buf = None
            if b is None:
                self.buf = b = [s, e, t, p]
            else:
                b[1], b[2] = max(b[1], e), _join(b[2], t)
                if b[3] is None:
                    b[3] = p
            if _ends_sentence(b[2]) or _width(b[2]) >= self.max_width or b[1] - b[0] >= self.max_dur:
                out.append(tuple(b[:3]))
                self.buf = None
        return [x for c in out for x in split_long(*c, max_width=self.max_width)]

    def flush(self):
        b, self.buf = self.buf, None
        return split_long(*b[:3], max_width=self.max_width) if b else []


def prepare_cc(items):
    """整理 CC 字幕：
    1. 「>>」（YouTube 自動字幕）或行首的「- 」（人工字幕的對話）代表換人說話，在那裡一定斷開；
    2. 把被切斷的句子接回完整的句子（換人的地方不會接在一起）。"""
    pieces = []
    for s, e, t in items:
        t = re.sub(r"(^|\n)\s*[-–—]\s+", ">> ", t)        # 人工字幕的對話破折號 → 換人記號
        parts = [x for x in t.split(">>")]
        if len(parts) == 1:
            pieces.append((s, e, t.strip(), False))
            continue
        total = sum(len(x.strip()) for x in parts) or 1
        cur = s
        for i, x in enumerate(parts):
            x = x.strip()
            if not x:
                continue
            d = (e - s) * len(x) / total
            pieces.append((cur, cur + d, x, i > 0 or t.lstrip().startswith(">>")))
            cur += d
    out = [(s, e, t, None, turn) for s, e, t, turn in pieces]
    return [c[:3] for c in merge_sentences(out)]


def merge_sentences(items, **kw):
    m = SentenceMerger(**kw)
    return m.feed(items) + m.flush()


def transcribe(model, audio_path, duration, on_segment, on_progress, should_stop, language=None):
    """邊辨識邊把每一段辨識結果交給 on_segment。language 有指定就照指定的語言辨識，否則自動偵測。回傳語言代碼。"""
    model.ready.wait()
    if model.model is None:
        raise RuntimeError(model.status)
    patch_av()
    with model.lock:
        segs, info = model.model.transcribe(
            audio_path, beam_size=5, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            word_timestamps=True, condition_on_previous_text=False,
            language=language or None,
            # 自動偵測時多看幾段再決定（只看開頭容易被片頭音樂誤判成別的語言）
            language_detection_segments=4, language_detection_threshold=0.6,
        )
        log.info("transcribe language=%s (requested %s, prob %.2f)", info.language, language or "auto",
                 getattr(info, "language_probability", 0) or 0)
        lang = info.language or ""
        total = duration or info.duration or 0
        on_progress(0.0, lang)
        for s in segs:
            if should_stop():
                raise InterruptedError("cancelled")
            t = s.text.strip()
            if not t or any(h in t for h in HALLU):
                continue
            if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:
                continue
            on_segment(s)
            if total:
                on_progress(min(1.0, s.end / total), lang)
        return lang


def cleanup_tmp(max_age=3600 * 6):
    now = time.time()
    for f in glob.glob(os.path.join(TMP_DIR, "*")):
        try:
            if now - os.path.getmtime(f) > max_age:
                os.remove(f)
        except OSError:
            pass
