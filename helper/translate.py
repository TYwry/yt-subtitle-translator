"""用 Groq 大型語言模型把字幕分批翻成台灣繁體中文（會參考前後文）。"""
import http.client
import json
import re
import time
import urllib.error
import urllib.request

from common import GROQ_MODELS, log

API = "https://api.groq.com/openai/v1/chat/completions"
BATCH = 25
FIRST_BATCH = 6     # 第一批只翻幾句就先送出，字幕更快出現中文

_CC = {}


def _opencc(name):
    if name not in _CC:
        try:
            from opencc import OpenCC
            _CC[name] = OpenCC(name)
        except Exception:  # 沒裝 opencc 時照原樣
            _CC[name] = None
    return _CC[name]


def convert(s, mode):
    """mode：s2tw（只轉字形）、s2twp（簡體→台灣用語）、t2s（繁→簡）、same／llm（不轉換）。"""
    if not s or mode not in ("s2tw", "s2twp", "t2s"):
        return s
    cc = _opencc(mode)
    return cc.convert(s) if cc else s


# 第一語言（翻譯目標）：代碼 → 給翻譯模型看的語言名稱
TARGETS = {
    "zh-Hant": "台灣繁體中文", "zh-Hans": "简体中文", "en": "English", "hi": "Hindi (हिन्दी)",
    "es": "Spanish (Español)", "ar": "Modern Standard Arabic (العربية)", "fr": "French (Français)",
    "bn": "Bengali (বাংলা)", "pt": "Portuguese (Português)", "ru": "Russian (Русский)",
    "id": "Indonesian (Bahasa Indonesia)",
}
_HANS = ("zh-hans", "zh-cn", "zh-sg", "zh")


def base(lang):
    return (lang or "").lower().replace("_", "-").split("-")[0]


def decide_mode(src, target):
    """原文跟第一語言相同時不用翻譯；中文簡繁之間用 OpenCC 轉換就好。"""
    b = base(src)
    if b in ("zh", "yue"):
        src_hans = (src or "").lower() in _HANS
        if target == "zh-Hant":
            return "s2twp" if src_hans else "same"
        if target == "zh-Hans":
            return "same" if src_hans else "t2s"
        return "llm"
    return "same" if b and b == base(target) else "llm"


SYSTEM = """你是專業的影片字幕翻譯。把使用者給的字幕逐行翻成「{target}」。
規則：
- 口語、自然、簡潔，{style}；不要逐字硬翻。
- 字幕要能放進一行：{brevity}。
- 一行對一行：輸出的編號必須和輸入完全相同，不可合併、拆分或省略任何一行。
- 每一行的譯文只能包含「那一行原文」的意思：絕對不可以把下一行的內容提前翻到這一行，也不可以把這一行的內容留到下一行。
  即使目標語言的語序不同，也要讓每一行的譯文和同一行的原文意思一一對應（必要時可用較口語的語序或「…」接續）。
- 人名、品牌、作品名可保留原文或用常見譯名；數字與單位照原意。
- 原文可能沒有標點、或有語音辨識的錯字，請依上下文推測正確意思。
- 只翻譯，不要加任何解釋。
- 輸出必須全部使用「{target}」。
- 只輸出 JSON 物件，格式：{{"1": "譯文", "2": "譯文", ...}}"""


class ModelUnavailable(Exception):
    pass


class GroqError(Exception):
    pass


class RateLimited(GroqError):
    def __init__(self, wait):
        super().__init__(f"Groq 速率限制，{wait:.0f} 秒後重試")
        self.wait = wait


def _post(key, body, timeout=60):
    req = urllib.request.Request(
        API, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "User-Agent": "ytsub-helper/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "ignore")[:300]
        except Exception:
            pass
        if e.code == 429:
            wait = 20.0
            try:
                wait = float(e.headers.get("retry-after") or wait)
            except ValueError:
                pass
            raise RateLimited(min(max(wait, 2.0), 120.0))
        if e.code == 401:
            raise GroqError("Groq 金鑰無效（401），請到擴充功能的設定頁重新輸入")
        if e.code == 403:
            raise GroqError("Groq 拒絕目前的網路連線（403），若有開 VPN 請先關閉")
        if e.code == 404:
            raise ModelUnavailable(f"Groq 找不到這個模型（404）：{detail[:120]}")
        raise GroqError(f"Groq HTTP {e.code}：{detail}")
    except urllib.error.URLError as e:
        raise GroqError(f"無法連線到 Groq（{e.reason}）")
    except TimeoutError:
        raise GroqError("Groq 回應逾時")
    except (OSError, http.client.HTTPException) as e:   # 連線中斷、回應不完整
        raise GroqError(f"與 Groq 的連線中斷（{e.__class__.__name__}）")


def _parse(content):
    content = (content or "").strip()
    if "</think>" in content:
        content = content.split("</think>", 1)[1]
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        raise GroqError("翻譯結果格式不正確")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise GroqError("翻譯結果格式不正確")
    return {str(k).strip(): (v if isinstance(v, str) else str(v)) for k, v in data.items()}


_DEAD_MODELS = set()   # 這次執行期間已確認不能用的模型（例如 Groq 已下架）
_COOLDOWN = {}         # 模型 → 速率限制解除的時間


def translate_batch(key, model, lines, context, title, target="zh-Hant", on_wait=None):
    """lines: 這批要翻的原文；context: 前面幾句原文（只供參考）。回傳等長的譯文清單（翻不出來的為空字串）。"""
    numbered = {str(i + 1): t for i, t in enumerate(lines)}
    user = ""
    if title:
        user += f"影片標題：{title}\n"
    if context:
        user += "前文（僅供參考，不用翻譯）：\n" + "\n".join(context) + "\n"
    user += "要翻譯的字幕：\n" + json.dumps(numbered, ensure_ascii=False)
    tname = TARGETS.get(target, TARGETS["zh-Hant"])
    style = "像台灣字幕組的翻譯" if target == "zh-Hant" else "像專業字幕組的翻譯"
    brevity = ("每行譯文盡量不超過 25 個字，可省略贅字與語助詞" if target in ("zh-Hant", "zh-Hans")
               else "keep each line short (about 60 characters or fewer), drop filler words")
    system = SYSTEM.format(target=tname, style=style, brevity=brevity)
    after = "s2tw" if target == "zh-Hant" else "t2s" if target == "zh-Hans" else ""
    models = [m for m in [model] + GROQ_MODELS if m in GROQ_MODELS or m == model]
    models = list(dict.fromkeys(models))
    last = None
    attempt = 0
    deadline = time.time() + 600          # 一批最多等 10 分鐘（含速率限制的等待）
    while attempt < 6 and time.time() < deadline:
        live = [m for m in models if m not in _DEAD_MODELS]
        if not live:
            break
        now = time.time()
        ready = [m for m in live if _COOLDOWN.get(m, 0) <= now]
        if not ready:
            # 每個模型都在速率限制中：等最快恢復的那個
            m = min(live, key=lambda x: _COOLDOWN.get(x, 0))
            wait = max(0.5, _COOLDOWN[m] - now)
            if on_wait:
                on_wait(f"Groq 速率限制，{wait:.0f} 秒後重試")
            time.sleep(wait)
            continue
        # 優先用使用者選的模型；它在冷卻時改用其他模型（Groq 每個模型的額度是分開算的）
        m = ready[min(attempt // 2, len(ready) - 1)]
        body = {"model": m, "temperature": 0.2, "max_tokens": 4096,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        if "gpt-oss" in m:
            body["reasoning_effort"] = "low"
            body["include_reasoning"] = False
        elif "qwen" in m:
            body["reasoning_effort"] = "none"
        try:
            data = _post(key, body)
            out = _parse(data["choices"][0]["message"].get("content"))
            res = [convert((out.get(str(i + 1)) or "").strip(), after) for i in range(len(lines))]
            if sum(1 for r in res if r) >= max(1, len(lines) * 0.6):
                return res
            last = GroqError("翻譯結果缺太多行")
            log.warning("translate attempt %d (%s): too many missing lines", attempt + 1, m)
        except ModelUnavailable as e:
            log.warning("model %s unavailable, skipping: %s", m, e)
            _DEAD_MODELS.add(m)
            last = e
            continue                     # 換下一個模型，不算一次嘗試
        except RateLimited as e:
            last = e
            _COOLDOWN[m] = time.time() + e.wait
            log.info("rate limited (%s), cooling down %.0fs", m, e.wait)
            continue                     # 不算一次嘗試，馬上換別的模型
        except GroqError as e:
            last = e
            if "401" in str(e) or "403" in str(e):
                raise
            log.warning("translate attempt %d (%s) failed: %s", attempt + 1, m, e)
            time.sleep(1.5 * (attempt + 1))
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
            last = GroqError(f"翻譯結果格式不正確：{e}")
            log.warning("translate attempt %d (%s) parse failed: %s", attempt + 1, m, e)
        attempt += 1
    raise last or GroqError("翻譯失敗")


# ───────────────────────── 大綱摘要 ─────────────────────────
SUMMARY_CHUNK = 9000   # 每段送給模型的字數上限（太長會超過 Groq 免費額度的每分鐘字數）

SUMMARY_SYSTEM = """你是影片內容整理專家。使用者會給你一段影片逐字稿，每行開頭的 [數字] 是該句開始的秒數。
請把內容依主題切成幾個段落，整理成精煉的大綱。
規則：
- 段落依時間先後排列，數量依內容多寡決定（這段逐字稿大約 {n} 段，可增減）。
- 每個段落的 start 必須是逐字稿裡某一行開頭的秒數（整數），代表這個主題開始的地方。
- title：10～20 字的小標題；points：2～4 個重點，每點一句話，寫具體內容（數字、名稱、結論），不要空泛。
- {overview}
- 所有文字都使用「{target}」。
- 只輸出 JSON 物件，格式：{{{fmt}"sections": [{{"start": 秒數, "title": "小標題", "points": ["重點", "重點"]}}]}}"""

OVERVIEW_SYSTEM = """你是影片內容整理專家。使用者會給你一部影片各段落的小標題與重點，請寫出整部影片的總覽：
2～4 句話，說明這部影片在講什麼、最重要的結論。所有文字都使用「{target}」。
只輸出 JSON 物件，格式：{{"overview": "總覽"}}"""


def _chat_json(key, model, system, user, on_wait=None, max_tokens=4096):
    """呼叫 Groq 並回傳 JSON 物件；遇到速率限制或模型下架時換其他模型。"""
    models = list(dict.fromkeys([m for m in [model] + GROQ_MODELS if m in GROQ_MODELS or m == model]))
    last = None
    attempt = 0
    deadline = time.time() + 600
    while attempt < 4 and time.time() < deadline:
        live = [m for m in models if m not in _DEAD_MODELS]
        if not live:
            break
        now = time.time()
        ready = [m for m in live if _COOLDOWN.get(m, 0) <= now]
        if not ready:
            m = min(live, key=lambda x: _COOLDOWN.get(x, 0))
            wait = max(0.5, _COOLDOWN[m] - now)
            if on_wait:
                on_wait(f"Groq 速率限制，{wait:.0f} 秒後重試")
            time.sleep(wait)
            continue
        m = ready[min(attempt // 2, len(ready) - 1)]
        body = {"model": m, "temperature": 0.3, "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        if "gpt-oss" in m:
            body["reasoning_effort"] = "low"
            body["include_reasoning"] = False
        elif "qwen" in m:
            body["reasoning_effort"] = "none"
        try:
            return _parse_obj(_post(key, body, timeout=90)["choices"][0]["message"].get("content"))
        except ModelUnavailable as e:
            _DEAD_MODELS.add(m)
            last = e
            continue
        except RateLimited as e:
            last = e
            _COOLDOWN[m] = time.time() + e.wait
            continue
        except GroqError as e:
            last = e
            if "401" in str(e) or "403" in str(e):
                raise
            log.warning("summary attempt %d (%s) failed: %s", attempt + 1, m, e)
            time.sleep(1.5 * (attempt + 1))
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
            last = GroqError(f"大綱結果格式不正確：{e}")
            log.warning("summary attempt %d (%s) parse failed: %s", attempt + 1, m, e)
        attempt += 1
    raise last or GroqError("產生大綱失敗")


def _parse_obj(content):
    content = (content or "").strip()
    if "</think>" in content:
        content = content.split("</think>", 1)[1]
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        raise GroqError("大綱結果格式不正確")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise GroqError("大綱結果格式不正確")
    return data


def _clean_sections(raw, starts):
    """整理模型回傳的段落：時間對齊到最接近的字幕開頭、去掉空白與重複。"""
    out = []
    for sec in raw if isinstance(raw, list) else []:
        if not isinstance(sec, dict):
            continue
        try:
            t = float(sec.get("start", 0))
        except (TypeError, ValueError):
            continue
        title = str(sec.get("title") or "").strip()[:80]
        pts = sec.get("points") if isinstance(sec.get("points"), list) else []
        pts = [str(p).strip()[:200] for p in pts if str(p).strip()][:5]
        if not title and not pts:
            continue
        s = min(starts, key=lambda x: abs(x - t)) if starts else t
        out.append({"start": round(s, 2), "title": title, "points": pts})
    out.sort(key=lambda x: x["start"])
    dedup = []
    for sec in out:
        if dedup and abs(dedup[-1]["start"] - sec["start"]) < 1:
            continue
        dedup.append(sec)
    return dedup


def summarize(key, model, cues, title, target="zh-Hant", on_progress=None):
    """cues: [(開始秒數, 文字)]。回傳 {"overview": str, "sections": [{start, title, points}]}。"""
    tname = TARGETS.get(target, TARGETS["zh-Hant"])
    after = "s2tw" if target == "zh-Hant" else "t2s" if target == "zh-Hans" else ""
    chunks, buf, size = [], [], 0
    for s, t in cues:
        line = f"[{int(s)}] {t}"
        if buf and size + len(line) > SUMMARY_CHUNK:
            chunks.append(buf)
            buf, size = [], 0
        buf.append((s, line))
        size += len(line) + 1
    if buf:
        chunks.append(buf)
    if not chunks:
        raise GroqError("沒有字幕可以整理")
    head = f"影片標題：{title}\n" if title else ""
    single = len(chunks) == 1
    sections, overview = [], ""
    for n, ch in enumerate(chunks):
        if on_progress:
            on_progress(f"整理第 {n + 1}/{len(chunks)} 段")
        dur = ch[-1][0] - ch[0][0]
        system = SUMMARY_SYSTEM.format(
            n=max(2, min(8, round(dur / 180) or 2)), target=tname,
            overview="overview：用 2～4 句話說明整部影片在講什麼、最重要的結論。" if single else "這只是影片的其中一部分，不用寫總覽。",
            fmt='"overview": "總覽", ' if single else "")
        user = head + "逐字稿：\n" + "\n".join(line for _, line in ch)
        data = _chat_json(key, model, system, user, on_wait=on_progress)
        sections += _clean_sections(data.get("sections"), [s for s, _ in ch])
        if single:
            overview = str(data.get("overview") or "").strip()
    if not single:
        if on_progress:
            on_progress("撰寫總覽")
        brief = "\n".join(f"- {s['title']}：{'；'.join(s['points'])}" for s in sections)
        data = _chat_json(key, model, OVERVIEW_SYSTEM.format(target=tname), head + brief, on_wait=on_progress, max_tokens=1024)
        overview = str(data.get("overview") or "").strip()
    if not sections:
        raise GroqError("大綱結果是空的")
    for s in sections:
        s["title"] = convert(s["title"], after)
        s["points"] = [convert(p, after) for p in s["points"]]
    return {"overview": convert(overview[:600], after), "sections": sections}
