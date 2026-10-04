"""YT 字幕助手：在本機背景執行，替 Chrome 擴充功能辨識影片聲音並翻譯字幕。
只接受本機（127.0.0.1）且帶正確通行碼的請求。"""
import hmac
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (APP_NAME, CACHE_DIR, EXTENSION_ID, GROQ_MODELS, HELPER_DIR, VERSION,  # noqa: E402
                    clean_key, decrypt_secret, encrypt_secret, load_config, load_json, log,
                    save_config, save_json, setup_logging)
import transcribe as tr  # noqa: E402
import translate as tl   # noqa: E402

CFG = {}
MODEL = tr.Model()
JOBS = {}
JOBS_LOCK = threading.Lock()
ASR_QUEUE = []                 # 等待辨識的工作（最新的優先）
ASR_EVENT = threading.Event()
SRC_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,60}$")
ABANDON_SECONDS = 60           # 擴充功能超過這麼久沒來查詢（例如已關掉分頁）就停止辨識
UPDATE_LOCK = threading.Lock()  # 更新 yt-dlp 期間暫停下載


def groq_key():
    enc = CFG.get("groq_key_enc")
    if not enc:
        return ""
    try:
        return decrypt_secret(enc)
    except Exception:
        log.warning("無法解密 Groq 金鑰（可能是從別台電腦複製過來的設定），請重新輸入")
        return ""


# ───────────────────────── 工作 ─────────────────────────
class Job:
    def __init__(self, jid, video_id, kind, title, lang, target, hint=""):
        self.id, self.video_id, self.kind, self.title = jid, video_id, kind, title
        self.lang = lang                  # 原文語言（空白 = 自動偵測）
        self.hint = hint                  # YouTube 提供的影片語言（自動偵測時參考）
        self.target = target              # 第一語言（翻譯成這個語言）
        self.mode = "llm"                 # llm = 用 Groq 翻譯；same / s2twp / t2s = 不用翻譯
        self.status = "queued"            # queued / downloading / transcribing / translating / done / error / cancelled
        self.progress = 0.0
        self.note = ""
        self.error = ""
        self.cues = []                    # [{s, e, o, z, r}]
        self.rev = 0
        self.asr_done = kind != "asr"
        self.last_poll = time.time()
        self.lock = threading.Lock()
        self.trans_event = threading.Event()
        self.play_pos = 0.0               # 擴充功能回報的目前播放秒數
        self.last_add = time.time()
        self.batches = 0
        self.gen = 0                      # 字幕整批重來（例如顯示卡出錯重新辨識）時 +1，舊的翻譯結果就不會寫錯位置
        if lang:
            self.mode = tl.decide_mode(lang, target)

    @property
    def single(self):                     # 原文跟第一語言相同：只顯示一行
        return self.mode != "llm"

    def add_cues(self, items):
        with self.lock:
            for item in items:
                s, e, t = item[0], item[1], item[2]
                self.rev += 1
                self.cues.append({"s": round(s, 3), "e": round(e, 3), "o": t, "z": "", "r": self.rev})
            self.last_add = time.time()
        self.trans_event.set()

    def set_zh(self, idx, texts, gen=None):
        with self.lock:
            if gen is not None and gen != self.gen:
                return
            for i, z in zip(idx, texts):
                if i >= len(self.cues):
                    continue
                self.rev += 1
                self.cues[i]["z"] = z
                self.cues[i]["r"] = self.rev

    def abandoned(self):
        return time.time() - self.last_poll > ABANDON_SECONDS

    def snapshot(self, since):
        with self.lock:
            changed = [dict(i=i, s=c["s"], e=c["e"], o=c["o"], z=c["z"])
                       for i, c in enumerate(self.cues) if c["r"] > since]
            done_n = sum(1 for c in self.cues if c["z"])
            return {"id": self.id, "status": self.status, "progress": round(self.progress, 3),
                    "note": self.note, "error": self.error, "lang": self.lang, "target": self.target, "single": self.single,
                    "total": len(self.cues), "translated": done_n, "rev": self.rev, "cues": changed}


CACHE_VER = "v4"   # 字幕切法改變時遞增，舊快取就不會再被使用


def cache_path(jid):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", jid)
    return os.path.join(CACHE_DIR, f"{safe}__{CACHE_VER}.json")


def load_cached(job):
    data = load_json(cache_path(job.id), None)
    if not data or not data.get("cues"):
        return False
    job.lang = data.get("lang", job.lang)
    job.mode = data.get("mode", "llm")
    job.add_cues([(c["s"], c["e"], c["o"]) for c in data["cues"]])
    job.set_zh(range(len(data["cues"])), [c.get("z", "") for c in data["cues"]])
    job.asr_done, job.status, job.progress = True, "done", 1.0
    return True


def save_cache(job):
    if any(not c["z"] for c in job.cues):
        return   # 有沒翻完的句子就不存，下次重新翻
    os.makedirs(CACHE_DIR, exist_ok=True)
    save_json(cache_path(job.id), {"video_id": job.video_id, "lang": job.lang, "target": job.target, "mode": job.mode,
                                   "created": time.time(),
                                   "cues": [{"s": c["s"], "e": c["e"], "o": c["o"], "z": c["z"]} for c in job.cues]})


def purge_cache():
    days = int(CFG.get("cache_days", 30) or 0)
    if days <= 0 or not os.path.isdir(CACHE_DIR):
        return
    cutoff = time.time() - days * 86400
    for f in os.listdir(CACHE_DIR):
        p = os.path.join(CACHE_DIR, f)
        try:
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass


def pick_batch(job, pending, size):
    """挑一批要翻的字幕：從「目前播放位置」附近第一句還沒翻的開始，連續取 size 句（才有上下文）。"""
    with job.lock:
        start = next((i for i in pending if job.cues[i]["e"] >= job.play_pos - 2), pending[0])
    run, prev = [], None
    for i in pending:
        if i < start:
            continue
        if prev is not None and i != prev + 1:
            break
        run.append(i)
        prev = i
        if len(run) >= size:
            break
    return run or pending[:size]


def near_playhead(job, pending):
    """播放位置附近 30 秒內有還沒翻的句子：不用等湊滿一批就先翻。
    但辨識還在一句一句送進來時，先等 3 句或稍停 1.5 秒，免得每句都單獨送一次（會更容易被 Groq 限速）。"""
    with job.lock:
        near = sum(1 for i in pending if job.play_pos - 2 <= job.cues[i]["s"] <= job.play_pos + 30)
    return near >= 3 or (near > 0 and time.time() - job.last_add >= 1.5)


def translator_loop(job):
    """把還沒翻的字幕分批送 Groq；辨識還在進行時，湊滿一批才送。"""
    try:
        while True:
            if job.abandoned():
                job.status = "cancelled"
                return
            with job.lock:
                pending = [i for i, c in enumerate(job.cues) if not c["z"]]
            if job.single:
                with job.lock:
                    idx = [i for i, c in enumerate(job.cues) if not c["z"]]
                    texts = [tl.convert(job.cues[i]["o"], job.mode) for i in idx]
                job.set_zh(idx, texts)
                pending = []
            elif pending and (len(pending) >= (tl.FIRST_BATCH if job.batches == 0 else tl.BATCH)
                              or job.asr_done or near_playhead(job, pending)):
                key = groq_key()
                if not key:
                    if not job.asr_done:          # 先讓辨識繼續，原文照樣顯示
                        job.note = "尚未設定 Groq 金鑰，只顯示原文"
                        job.trans_event.wait(2.0)
                        job.trans_event.clear()
                        continue
                    raise tl.GroqError("尚未設定 Groq 金鑰，只能顯示原文。請到擴充功能的設定頁輸入金鑰")
                idx = pick_batch(job, pending, tl.FIRST_BATCH if job.batches == 0 else tl.BATCH)
                job.batches += 1
                with job.lock:
                    gen = job.gen
                    lines = [job.cues[i]["o"] for i in idx]
                    ctx = [c["o"] for c in job.cues[max(0, idx[0] - 4):idx[0]]]
                if job.asr_done and job.kind != "asr":
                    job.status = "translating"
                job.note = ""
                res = tl.translate_batch(key, CFG.get("groq_model") or GROQ_MODELS[0], lines, ctx, job.title, job.target,
                                         on_wait=lambda m: setattr(job, "note", m))
                job.note = ""
                job.set_zh(idx, [r or "" for r in res], gen)
                # 少數翻不出來的行，下一輪不再重送，避免無限重試
                with job.lock:
                    if gen != job.gen:
                        continue
                    for i, r in zip(idx, res):
                        if not r:
                            job.rev += 1
                            job.cues[i]["z"] = " "
                            job.cues[i]["r"] = job.rev
                continue
            if job.asr_done and not pending:
                job.status, job.progress = "done", 1.0
                save_cache(job)
                return
            job.trans_event.wait(1.0)
            job.trans_event.clear()
    except Exception as e:
        log.warning("translate job %s failed: %s", job.id, e)
        job.error = str(e)
        job.status = "error"


def asr_worker():
    while True:
        ASR_EVENT.wait()
        with JOBS_LOCK:
            ASR_QUEUE[:] = [j for j in ASR_QUEUE if not j.abandoned()]
            job = ASR_QUEUE.pop() if ASR_QUEUE else None
            if not ASR_QUEUE:
                ASR_EVENT.clear()
        if not job:
            continue
        run_asr(job)


def run_asr(job):
    stop = job.abandoned
    path = None
    try:
        job.status, job.note = "downloading", "下載影片聲音中…"
        with UPDATE_LOCK:
            pass
        path, duration = tr.download_audio(job.video_id, lambda p: setattr(job, "progress", p * 0.05), stop)
        job.status, job.note = "transcribing", ""   # 模型還在載入時，查詢時會顯示載入狀態
        threading.Thread(target=translator_loop, args=(job,), daemon=True).start()

        def on_prog(p, lang):
            job.progress = 0.05 + p * 0.95
            if lang and job.lang != lang:
                job.lang = lang
                job.mode = tl.decide_mode(lang, job.target)

        def run():
            merger = tr.SentenceMerger()

            def on_segment(seg):
                job.add_cues(merger.feed(tr.segments_to_cues(seg)))
            tr.transcribe(MODEL, path, duration, on_segment, on_prog, stop, language=job.lang or job.hint or None)
            job.progress = 1.0          # 語音辨識完成（片尾若是音樂，進度原本會停在 7、8 成）
            job.add_cues(merger.flush())
        try:
            run()
        except Exception as e:
            if not tr.is_cuda_error(e):
                raise
            log.warning("CUDA 錯誤，重新載入模型後再試：%s", e)   # 常見於電腦睡眠喚醒後
            with job.lock:
                job.cues.clear()
                job.gen += 1
                job.rev += 1
            MODEL.load(CFG)
            run()
        job.asr_done = True
        job.trans_event.set()
        if job.status not in ("error", "cancelled"):
            job.status = "translating" if not job.single else job.status
    except InterruptedError:
        job.status = "cancelled"
    except Exception as e:
        msg = str(e)
        if "cancelled" in msg.lower():
            job.status = "cancelled"
        else:
            log.warning("asr job %s failed: %s", job.id, msg)
            low = msg.lower()
            if "sign in" in low or "confirm your age" in low:
                msg = "這部影片需要登入或有年齡限制，無法下載聲音"
            elif "members" in low or "private video" in low:
                msg = "會員限定或私人影片，無法下載聲音"
            job.error, job.status = (msg[:300] or "辨識失敗"), "error"
    finally:
        if path:
            try:
                os.remove(path)
            except OSError:
                pass


def create_job(body):
    vid = str(body.get("video_id", ""))
    kind = body.get("kind")
    src = str(body.get("source", kind or ""))
    target = str(body.get("target") or "zh-Hant")
    lang = str(body.get("lang") or "")[:20]
    hint = str(body.get("hint") or "")[:20]
    if not tr.VIDEO_ID_RE.match(vid) or kind not in ("asr", "cc") or not SRC_RE.match(src) \
            or target not in tl.TARGETS:
        raise ValueError("參數不正確")
    if kind == "asr":                    # 本機辨識只接受 Whisper 認得的語言代碼
        lang = lang if lang in tr.WHISPER_LANGS else ""
        hint = tl.base(hint) if tl.base(hint) in tr.WHISPER_LANGS else ""
    jid = f"{vid}__{src}__{target}"
    title = str(body.get("title", ""))[:200]
    with JOBS_LOCK:
        old = JOBS.get(jid)
        if old and old.status not in ("error", "cancelled"):
            old.last_poll = time.time()
            return old
        job = Job(jid, vid, kind, title, lang, target, hint)
        JOBS[jid] = job
        # 舊工作只保留最近 30 個
        if len(JOBS) > 30:
            for k in sorted(JOBS, key=lambda k: JOBS[k].last_poll)[:len(JOBS) - 30]:
                if JOBS[k].status in ("done", "error", "cancelled"):
                    JOBS.pop(k, None)
    if load_cached(job):
        return job
    if kind == "cc":
        cues = body.get("cues") or []
        if not isinstance(cues, list) or len(cues) > 8000:
            raise ValueError("字幕太多或格式不正確")
        items = []
        for c in cues:
            try:
                t = str(c.get("t", "")).strip()[:500]
                if t:
                    items.append((float(c["s"]), float(c["e"]), t))
            except (TypeError, ValueError, KeyError, AttributeError):
                continue
        job.add_cues(tr.prepare_cc(items))   # 先把斷掉的句子接起來；「>>」換人記號一定斷開
        job.asr_done = True
        job.status = "translating"
        threading.Thread(target=translator_loop, args=(job,), daemon=True).start()
    else:
        with JOBS_LOCK:
            ASR_QUEUE.append(job)
            ASR_EVENT.set()
    return job


# ───────────────────────── 大綱摘要 ─────────────────────────
SUMMARIES = {}                 # 「影片__語言」→ {status: running/done/error, note, data, error}
SUMMARY_VER = "v1"


def summary_path(vid, target):
    return os.path.join(CACHE_DIR, f"summary__{vid}__{target}__{SUMMARY_VER}.json")


def summary_args(src):
    vid = str(src.get("video_id", ""))
    target = str(src.get("target") or "zh-Hant")
    if not tr.VIDEO_ID_RE.match(vid) or target not in tl.TARGETS:
        raise ValueError("參數不正確")
    return vid, target


def get_summary(vid, target):
    with JOBS_LOCK:
        s = SUMMARIES.get(f"{vid}__{target}")
        if s:
            return dict(s)
    data = load_json(summary_path(vid, target), None)
    if data and data.get("sections"):
        return {"status": "done", "data": data}
    return {"status": "none"}


def start_summary(body):
    vid, target = summary_args(body)
    cur = get_summary(vid, target)
    if cur["status"] in ("running", "done"):
        return cur
    key = groq_key()
    if not key:
        raise ValueError("還沒設定 Groq 金鑰，請到擴充功能的設定頁輸入")
    cues = body.get("cues") or []
    if not isinstance(cues, list) or len(cues) > 8000:
        raise ValueError("字幕太多或格式不正確")
    items = []
    for c in cues:
        try:
            t = str(c.get("t", "")).strip()[:500]
            if t:
                items.append((float(c["s"]), t))
        except (TypeError, ValueError, KeyError, AttributeError):
            continue
    if not items:
        raise ValueError("沒有字幕可以整理")
    title = str(body.get("title", ""))[:200]
    k = f"{vid}__{target}"
    state = {"status": "running", "note": "準備中"}
    with JOBS_LOCK:
        SUMMARIES[k] = state

    def run():
        def prog(msg):
            state["note"] = msg
        try:
            data = tl.summarize(key, CFG.get("groq_model") or GROQ_MODELS[0], items, title, target, on_progress=prog)
            data.update({"video_id": vid, "target": target, "created": time.time()})
            os.makedirs(CACHE_DIR, exist_ok=True)
            save_json(summary_path(vid, target), data)
            state.update(status="done", data=data, note="")
        except Exception as e:
            log.warning("summary failed: %s", e)
            state.update(status="error", error=str(e)[:300] or "產生大綱失敗", note="")
        finally:
            with JOBS_LOCK:          # 只在記憶體留著「進行中」的狀態；完成或失敗後改從快取檔讀（失敗可以再按一次）
                if state["status"] == "done":
                    SUMMARIES.pop(k, None)
                elif len(SUMMARIES) > 50:
                    SUMMARIES.pop(next(iter(SUMMARIES)), None)

    threading.Thread(target=run, daemon=True).start()
    return dict(state)


# ───────────────────────── HTTP ─────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "ytsub-helper"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self, need_token=True):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):          # 防止 DNS rebinding
            return False
        origin = self.headers.get("Origin")
        if origin and origin != f"chrome-extension://{EXTENSION_ID}":
            return False                                     # 一般網頁不能呼叫
        if need_token:
            tok = self.headers.get("X-Ytsub-Token") or ""
            return hmac.compare_digest(tok.encode(), CFG["token"].encode())
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > 5_000_000:
            raise ValueError("資料太大")
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/ping":
            if not self._allowed(need_token=False):
                return self._send(403, {"error": "forbidden"})
            return self._send(200, {"app": "ytsub-helper", "version": VERSION, "model": MODEL.status,
                                    "has_key": bool(CFG.get("groq_key_enc"))})
        if not self._allowed():
            return self._send(403, {"error": "通行碼錯誤"})
        if u.path.startswith("/jobs/"):
            jid = u.path[len("/jobs/"):]
            job = JOBS.get(jid)
            if not job:
                return self._send(404, {"error": "找不到工作"})
            job.last_poll = time.time()
            q = parse_qs(u.query)
            try:
                since = int(q.get("since", ["0"])[0])
            except ValueError:
                since = 0
            try:
                pos = float(q.get("pos", [""])[0])
                if pos >= 0:
                    job.play_pos = pos
                    job.trans_event.set()
            except ValueError:
                pass
            snap = job.snapshot(since)
            if job.status == "transcribing" and MODEL.model is None:
                snap["note"] = MODEL.status
            return self._send(200, snap)
        if u.path == "/config":
            return self._send(200, public_config())
        if u.path == "/summary":
            q = parse_qs(u.query)
            try:
                vid, target = summary_args({"video_id": q.get("video_id", [""])[0], "target": q.get("target", [""])[0]})
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            return self._send(200, get_summary(vid, target))
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return self._send(403, {"error": "通行碼錯誤"})
        try:
            body = self._body()
            u = urlparse(self.path)
            if u.path == "/jobs":
                job = create_job(body)
                return self._send(200, job.snapshot(0))
            if u.path == "/config":
                return self._send(200, update_config(body))
            if u.path == "/summary":
                return self._send(200, start_summary(body))
            return self._send(404, {"error": "not found"})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            log.exception("request failed")
            return self._send(500, {"error": str(e)})


def public_config():
    return {"has_key": bool(CFG.get("groq_key_enc")), "groq_model": CFG.get("groq_model"),
            "groq_models": GROQ_MODELS, "cache_days": CFG.get("cache_days", 30),
            "model": MODEL.status, "autostart": bool(CFG.get("autostart")), "cache_count": cache_count()}


def cache_count():
    try:
        return sum(1 for f in os.listdir(CACHE_DIR) if f.endswith(".json") and not f.startswith("summary__"))
    except OSError:
        return 0


def update_config(body):
    if "groq_key" in body:
        k = clean_key(str(body.get("groq_key") or ""))
        CFG["groq_key_enc"] = encrypt_secret(k) if k else ""
    if body.get("groq_model") in GROQ_MODELS:
        CFG["groq_model"] = body["groq_model"]
    if "cache_days" in body:
        try:
            CFG["cache_days"] = max(0, min(365, int(body["cache_days"])))
        except (TypeError, ValueError):
            pass
    if "autostart" in body:
        set_autostart(bool(body["autostart"]))
        CFG["autostart"] = bool(body["autostart"])
    if body.get("clear_cache"):
        if os.path.isdir(CACHE_DIR):
            for f in os.listdir(CACHE_DIR):
                if f.endswith(".json"):
                    try:
                        os.remove(os.path.join(CACHE_DIR, f))
                    except OSError:
                        pass
        with JOBS_LOCK:
            for k in [k for k, j in JOBS.items() if j.status in ("done", "error", "cancelled")]:
                JOBS.pop(k, None)
    save_config(CFG)
    return public_config()


# ───────────────────────── 開機自動啟動／系統匣圖示 ─────────────────────────
def startup_lnk():
    return os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs\Startup",
                        "YT 字幕助手.lnk")


def set_autostart(on):
    if os.name != "nt":
        return
    import subprocess
    p = startup_lnk()
    if on:
        exe = sys.executable
        if exe.lower().endswith("python.exe"):
            exe = exe[:-10] + "pythonw.exe"
        ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:YS_LNK);"
              "$s.TargetPath=$env:YS_T;$s.Arguments=$env:YS_A;$s.WorkingDirectory=$env:YS_D;"
              "$s.IconLocation=$env:YS_I;$s.Save()")
        env = dict(os.environ, YS_LNK=p, YS_T=exe, YS_A=f'"{os.path.abspath(__file__)}"', YS_D=HELPER_DIR,
                   YS_I=os.path.join(HELPER_DIR, "icon.ico"))
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
                       env=env, check=True, capture_output=True, creationflags=0x08000000)
    elif os.path.exists(p):
        os.remove(p)


def make_icon(size=64):
    from PIL import Image
    return Image.open(os.path.join(HELPER_DIR, "icon.png")).convert("RGBA").resize((size, size), Image.LANCZOS)


def run_tray(httpd):
    try:
        import pystray
    except Exception:
        log.warning("pystray unavailable; running without tray icon")
        threading.Event().wait()
        return

    def quit_app(icon, item):
        icon.stop()
        httpd.shutdown()
        os._exit(0)

    def toggle_auto(icon, item):
        try:
            update_config({"autostart": not CFG.get("autostart")})
        except Exception:
            log.exception("autostart")

    def open_folder(icon, item):
        os.startfile(HELPER_DIR)

    menu = pystray.Menu(
        pystray.MenuItem(lambda it: f"語音模型：{MODEL.status}", None, enabled=False),
        pystray.MenuItem("開機自動啟動", toggle_auto, checked=lambda it: bool(CFG.get("autostart"))),
        pystray.MenuItem("開啟資料夾", open_folder),
        pystray.MenuItem("結束", quit_app),
    )
    pystray.Icon("ytsub-helper", make_icon(), f"{APP_NAME}（執行中）", menu).run()


def update_ytdlp():
    """YouTube 常改版，yt-dlp 需要常更新：每 3 天在背景自動更新一次（失敗就沿用舊版）。"""
    import subprocess
    if time.time() - float(CFG.get("ytdlp_checked", 0) or 0) < 3 * 86400:
        return
    with UPDATE_LOCK:
        try:
            r = subprocess.run([sys.executable.replace("pythonw.exe", "python.exe"), "-m", "pip", "install", "-U", "-q",
                                "--disable-pip-version-check", "yt-dlp[default,deno]"],
                               capture_output=True, timeout=300, creationflags=0x08000000 if os.name == "nt" else 0)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or b"")[-200:].decode("utf-8", "ignore"))
            CFG["ytdlp_checked"] = time.time()
            save_config(CFG)
            log.info("yt-dlp update checked")
        except Exception as e:
            log.warning("yt-dlp update failed: %s", e)


def cleanup_unused():
    """移除已經不用的「說話者辨識」：套件、模型與程式檔（只刪下面這幾個固定位置）。"""
    import shutil
    import subprocess
    targets = [os.path.join(HELPER_DIR, "models", "diarization"), os.path.join(HELPER_DIR, "diarize.py")]
    for t in targets:
        try:
            if os.path.isdir(t):
                shutil.rmtree(t)
                log.info("removed unused folder: %s", os.path.relpath(t, HELPER_DIR))
            elif os.path.isfile(t):
                os.remove(t)
                log.info("removed unused file: %s", os.path.relpath(t, HELPER_DIR))
        except OSError as e:
            log.warning("could not remove %s: %s", t, e)
    pyc = os.path.join(HELPER_DIR, "__pycache__")
    if os.path.isdir(pyc):
        for f in os.listdir(pyc):
            if f.startswith("diarize."):
                try:
                    os.remove(os.path.join(pyc, f))
                except OSError:
                    pass
    try:
        import importlib.util
        if importlib.util.find_spec("sherpa_onnx") is not None:
            r = subprocess.run([sys.executable.replace("pythonw.exe", "python.exe"), "-m", "pip", "uninstall", "-y", "-q",
                                "sherpa-onnx", "sherpa-onnx-core"], capture_output=True, timeout=300,
                               creationflags=0x08000000 if os.name == "nt" else 0)
            log.info("uninstall sherpa-onnx: %s", "ok" if r.returncode == 0 else r.stderr[-200:])
    except Exception as e:
        log.warning("uninstall sherpa-onnx failed: %s", e)
    # 舊版格式的字幕快取用不到了
    if os.path.isdir(CACHE_DIR):
        for f in os.listdir(CACHE_DIR):
            if f.endswith(".json") and not f.endswith(f"__{CACHE_VER}.json"):
                try:
                    os.remove(os.path.join(CACHE_DIR, f))
                except OSError:
                    pass


def helper_running_on(port):
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=1.5) as r:
            return json.loads(r.read().decode()).get("app") == "ytsub-helper"
    except Exception:
        return False


def main():
    global CFG
    setup_logging()
    CFG = load_config()
    httpd = None
    base_port = int(CFG.get("port", 8765))
    for port in [base_port] + [p for p in range(8765, 8776) if p != base_port]:
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            if helper_running_on(port):
                log.info("helper already running on port %s", port)
                return
            log.info("port %s is used by another program, trying next", port)   # 被別的程式占用：換下一個
    if httpd is None:
        log.warning("no free port between 8765 and 8775")
        return
    if port != CFG.get("port"):
        CFG["port"] = port
        save_config(CFG)
    httpd.daemon_threads = True
    log.info("%s %s listening on 127.0.0.1:%s", APP_NAME, VERSION, port)
    purge_cache()
    tr.cleanup_tmp(0)
    threading.Thread(target=update_ytdlp, daemon=True).start()
    threading.Thread(target=MODEL.load, args=(CFG,), daemon=True).start()
    threading.Thread(target=cleanup_unused, daemon=True).start()
    threading.Thread(target=asr_worker, daemon=True).start()
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def daily():
        while True:
            time.sleep(86400)
            purge_cache()
            tr.cleanup_tmp()
    threading.Thread(target=daily, daemon=True).start()
    if "--no-tray" in sys.argv:
        threading.Event().wait()
    else:
        run_tray(httpd)


if __name__ == "__main__":
    main()
