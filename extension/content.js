// YouTube 中文字幕翻譯：決定字幕來源、顯示雙語字幕、本機助手未開啟時提醒。
(() => {
  const TAG = '__ytsub';
  const DEFAULTS = { enabled: true, display: 'bi', size: 100, bottom: 8, bgOpacity: 55, remind: 'always', targetLang: 'zh-Hant', sourceLang: 'auto' };
  // 語言名稱（顯示在狀態列）
  const LANG_NAMES = {
    'zh-Hant': '繁體中文', 'zh-Hans': '簡體中文', zh: '中文', en: '英文', hi: '印地語', es: '西班牙語', ar: '阿拉伯語',
    fr: '法語', bn: '孟加拉語', pt: '葡萄牙語', ru: '俄語', id: '印尼語', ja: '日語', ko: '韓語', de: '德語',
  };
  const langName = (l) => LANG_NAMES[l] || LANG_NAMES[(l || '').split('-')[0]] || l;
  let settings = { ...DEFAULTS };
  let cur = null;        // 目前影片的狀態
  let seq = 0;           // 每換一部影片 +1，舊的非同步工作看到不一致就停止
  let reqId = 0;
  const pending = {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res));
    } catch (e) {
      resolve({ ok: false, error: String(e) });   // 擴充功能剛重新載入時會發生
    }
  });

  // ───────── 跟 page-hook.js（頁面內）溝通 ─────────
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m[TAG] !== 'res' || !pending[m.id]) return;
    pending[m.id](m.res);
    delete pending[m.id];
  });
  function page(type, data, timeout = 15000) {
    const id = ++reqId;
    return new Promise((resolve) => {
      pending[id] = resolve;
      window.postMessage({ [TAG]: 'req', id, type, ...data }, '*');
      setTimeout(() => {
        if (pending[id]) { delete pending[id]; resolve({ ok: false, error: '逾時' }); }
      }, timeout);
    });
  }

  // ───────── 字幕檔解析 ─────────
  function parseJson3(j, regroup) {
    const events = (j && j.events) || [];
    if (regroup) return regroupWords(events);
    const cues = [];
    for (const e of events) {
      if (!e.segs) continue;
      const t = e.segs.map((x) => x.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim();
      if (!t) continue;
      const s = (e.tStartMs || 0) / 1000;
      cues.push({ s, e: s + (e.dDurationMs || 2000) / 1000, o: t, z: '' });
    }
    cues.sort((a, b) => a.s - b.s);
    for (let i = 0; i + 1 < cues.length; i++) {
      if (cues[i + 1].s > cues[i].s && cues[i + 1].s < cues[i].e) cues[i].e = cues[i + 1].s;
    }
    return cues;
  }

  // YouTube 自動字幕是一個字一個字出現的，重新組成一句一句
  function regroupWords(events) {
    const words = [];
    for (const e of events) {
      if (!e.segs) continue;
      for (const sg of e.segs) {
        const t = sg.utf8 || '';
        if (!t.trim()) continue;
        words.push({ s: ((e.tStartMs || 0) + (sg.tOffsetMs || 0)) / 1000, t });
      }
    }
    words.sort((a, b) => a.s - b.s);
    const cues = [];
    let cur = null;
    const cjk = /[぀-ヿ㐀-鿿가-힯]/;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      const end = next ? Math.min(next.s, w.s + 1.5) : w.s + 0.8;
      // 停頓夠久才換句；句子已經很長時，短一點的停頓也換句（自動字幕通常沒有標點）
      if (cur && (w.s - cur.e > 1.0 || (cur.o.length >= 40 && w.s - cur.e > 0.4))) { cues.push(cur); cur = null; }
      if (!cur) cur = { s: w.s, e: end, o: '', z: '' };
      cur.o += (cur.o && !cjk.test(w.t[0]) && !/^\s/.test(w.t) ? ' ' : '') + w.t;
      cur.e = end;
      const txt = cur.o.trim();
      if (txt.length >= 70 || cur.e - cur.s >= 6 || (/[.?!。？！]["'”’」』)）]*$/.test(txt) && cur.e - cur.s >= 1.2)) {
        cur.o = txt; cues.push(cur); cur = null;
      }
    }
    if (cur) { cur.o = cur.o.trim(); cues.push(cur); }
    for (const c of cues) c.o = c.o.replace(/\s+/g, ' ').trim();
    return cues.filter((c) => c.o);
  }

  // ───────── 畫面元件 ─────────
  const player = () => document.getElementById('movie_player');
  const video = () => { const p = player(); return p && p.querySelector('video'); };
  let ui = null;

  function ensureUI() {
    const p = player();
    if (!p) return null;
    if (ui && p.contains(ui.overlay)) return ui;
    const overlay = document.createElement('div');
    overlay.className = 'ytsub-overlay';
    overlay.innerHTML = '<div class="ytsub-box"><div class="ytsub-zh" dir="auto"></div><div class="ytsub-orig" dir="auto"></div></div>';
    const status = document.createElement('div');
    status.className = 'ytsub-status';
    status.setAttribute('role', 'status');
    const card = document.createElement('div');
    card.className = 'ytsub-card';
    card.setAttribute('role', 'alert');
    p.append(overlay, status, card);
    ui = { overlay, box: overlay.firstChild, zh: overlay.querySelector('.ytsub-zh'), orig: overlay.querySelector('.ytsub-orig'), status, card };
    applyStyle();
    return ui;
  }

  function applyStyle() {
    const p = player();
    if (!p) return;
    p.style.setProperty('--ytsub-scale', String(settings.size / 100));
    p.style.setProperty('--ytsub-bottom', settings.bottom + '%');
    p.style.setProperty('--ytsub-bg', `rgba(8,8,8,${settings.bgOpacity / 100})`);
    p.classList.toggle('ytsub-zh-only', settings.display === 'zh');
  }

  let statusTimer = null;
  function setStatus(text, kind = 'info', autoHide = 0) {
    if (cur) { cur.statusText = text; cur.statusKind = kind; }
    const u = ensureUI();
    if (!u) return;
    clearTimeout(statusTimer);
    if (!text || !settings.enabled) { u.status.classList.remove('show'); return; }
    u.status.textContent = text;
    u.status.dataset.kind = kind;
    u.status.classList.add('show');
    if (autoHide) statusTimer = setTimeout(() => u.status.classList.remove('show'), autoHide);
  }

  // ───────── 控制列上的「中」按鈕 ─────────
  function ensureButton() {
    const bar = document.querySelector('#movie_player .ytp-right-controls');
    if (!bar) return;
    let b = bar.querySelector('.ytsub-btn');
    if (!b) {
      b = document.createElement('button');
      b.className = 'ytp-button ytsub-btn';
      b.type = 'button';
      b.textContent = '中';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.storage.local.set({ enabled: !settings.enabled });
      });
      bar.prepend(b);
    }
    b.classList.toggle('on', settings.enabled);
    const label = settings.enabled ? '關閉字幕翻譯' : '開啟字幕翻譯';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(settings.enabled));
  }

  // ───────── 依播放時間顯示字幕 ─────────
  let lastShown = null;
  // 最後一句「已經開始」的字幕位置（都還沒開始就是 -1）
  function lastStarted(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function findCue(cues, t) {
    const ans = lastStarted(cues, t);
    for (let i = ans; i >= 0 && i > ans - 3; i--) if (t < cues[i].e) return cues[i];
    return null;
  }

  let lastH = 0;
  function render() {
    const p = player();
    const v = video();
    if (!p || !v) return;
    const h = p.clientHeight;
    if (h && h !== lastH) {   // 字級跟著播放器大小（一般／劇院／全螢幕）
      lastH = h;
      p.style.setProperty('--ytsub-zh-px', Math.max(16, Math.min(48, h * 0.042)).toFixed(1) + 'px');
    }
    ensureButton();
    const u = ensureUI();
    if (!u) return;
    const active = settings.enabled && cur && cur.cues.length && location.pathname === '/watch';
    p.classList.toggle('ytsub-hide-native', !!(settings.enabled && cur && cur.hideNative));
    if (!active) {
      // 關閉時一律把字幕藏起來（以前只在「剛剛有顯示」時才藏，關掉後會殘留最後一句）
      u.overlay.classList.remove('show');
      lastShown = null;
      return;
    }
    const c = findCue(cur.cues, v.currentTime);
    const zhOnly = cur.single || settings.display === 'zh';
    let zh = '', orig = '';
    if (c) {
      const z = (c.z || '').trim();
      if (z) { zh = z; orig = zhOnly ? '' : c.o; } else { zh = ''; orig = c.o; }
    }
    const key = zh + '\u0000' + orig;
    if (key === lastShown) return;
    lastShown = key;
    u.zh.textContent = zh;
    u.orig.textContent = orig;
    u.zh.style.display = zh ? '' : 'none';
    u.orig.style.display = orig ? '' : 'none';
    u.orig.classList.toggle('pending', !zh && !!orig);
    u.overlay.classList.toggle('show', !!(zh || orig));
  }
  setInterval(() => { render(); updatePanel(); }, 100);

  // ───────── 提醒卡片 ─────────
  let cardTimer = null;
  function hideCard() {
    if (ui) ui.card.classList.remove('show');
    clearTimeout(cardTimer);
  }
  function showCard(html, buttons, autoHide = 10000) {
    const u = ensureUI();
    if (!u) return;
    u.card.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'ytsub-card-body';
    body.innerHTML = html;
    const row = document.createElement('div');
    row.className = 'ytsub-card-actions';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.text;
      if (b.primary) el.className = 'primary';
      el.addEventListener('click', (e) => { e.stopPropagation(); b.onClick(el); });
      row.append(el);
    }
    u.card.append(body, row);
    u.card.classList.add('show');
    clearTimeout(cardTimer);
    const arm = () => { clearTimeout(cardTimer); if (autoHide) cardTimer = setTimeout(hideCard, autoHide); };
    u.card.onmouseenter = () => clearTimeout(cardTimer);
    u.card.onmouseleave = arm;
    arm();
  }

  async function maybeRemind(my, hasCC) {
    if (settings.remind === 'never' || (settings.remind === 'nocc' && hasCC)) return;
    const d = await send({ type: 'reminderDismissed' });
    if (d && d.dismissed) return;
    const v = video();
    // 等影片真的開始播放才提醒
    for (let i = 0; i < 600 && v && (v.paused || v.readyState < 3); i++) {
      await sleep(500);
      if (my !== seq) return;
    }
    if (my !== seq || !settings.enabled) return;
    const msg = hasCC
      ? '目前先用 YouTube 內建翻譯（比較生硬）。開啟後會改用更自然的翻譯。'
      : '這部影片沒有字幕，需要本機助手才能辨識聲音。';
    showCard(`<strong>本機助手未開啟</strong><span>${msg}</span>`, [
      { text: '立即開啟', primary: true, onClick: (el) => openHelper(el, my) },
      { text: '這次先不用', onClick: () => { send({ type: 'dismissReminder' }); hideCard(); } },
    ]);
  }

  async function openHelper(el, my) {
    el.disabled = true;
    el.textContent = '開啟中…';
    clearTimeout(cardTimer);
    const r = await send({ type: 'startHelper' });
    if (r && r.ok) {
      showCard('<strong>本機助手已開啟 ✓</strong><span>正在準備字幕…</span>', [], 3000);
      if (my === seq && cur) restart();
    } else {
      showCard('<strong>無法自動開啟本機助手</strong><span>請到專案資料夾（yt-subtitle-translator）雙擊 <b>start-helper.bat</b>。第一次使用需要先安裝，之後這個按鈕就能直接開啟。</span>',
        [{ text: '知道了', onClick: hideCard }], 20000);
    }
  }

  // ───────── 本機助手是舊版（擴充功能更新後還沒重新啟動助手） ─────────
  const EXT_VERSION = chrome.runtime.getManifest().version;
  function helperIsOld(v) {
    if (!v) return true;        // 1.1.1 以前的助手不會回報版本以外的新功能，一律當舊版
    const a = v.split('.').map(Number), b = EXT_VERSION.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
    return false;
  }

  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let oldHelperShown = false;
  function remindOldHelper(my, v) {
    if (oldHelperShown) return;
    oldHelperShown = true;
    showCard(`<strong>本機助手需要更新</strong><span>電腦上執行的本機助手是舊版（${esc(v || '1.1.1 或更早')}），擴充功能已經是 ${EXT_VERSION}。重新啟動後才能使用大綱等新功能（進行中的辨識會重新開始）。</span>`, [
      { text: '立即重新啟動', primary: true, onClick: (el) => restartHelper(el, my) },
      { text: '稍後', onClick: hideCard },
    ], 20000);
  }

  async function restartHelper(el, my) {
    if (el) { el.disabled = true; el.textContent = '重新啟動中…'; }
    clearTimeout(cardTimer);
    const r = await send({ type: 'restartHelper' });
    if (r && r.ok) {
      showCard('<strong>本機助手已更新 ✓</strong><span>正在重新準備字幕…</span>', [], 3000);
      if (my === seq && cur) restart();
    } else {
      showCard(`<strong>無法自動重新啟動</strong><span>${esc((r && r.error) || '請在系統匣的紅色「T」圖示按右鍵 →「結束」，再雙擊 start-helper.bat。')}</span>`,
        [{ text: '知道了', onClick: hideCard }], 20000);
    }
  }

  // ───────── 主流程：決定字幕來源 ─────────
  const HANT = ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'];
  const HANS = ['zh-hans', 'zh-cn', 'zh-sg', 'zh'];
  const base = (l) => (l || '').toLowerCase().replace('_', '-').split('-')[0];

  // 字幕軌是不是「第一語言」
  function isTargetLang(lang, target) {
    const l = (lang || '').toLowerCase();
    if (target === 'zh-Hant') return HANT.includes(l);
    if (target === 'zh-Hans') return HANS.includes(l);
    return base(l) === base(target);
  }

  // 判斷影片實際說的語言：使用者有指定就用指定的；否則看 YouTube 標示的原音軌語言
  function spokenLang(data) {
    if (settings.sourceLang && settings.sourceLang !== 'auto') return settings.sourceLang;
    if (data.audioLang) return base(data.audioLang);
    const asr = (data.tracks || []).filter((t) => t.kind === 'asr');
    if (asr.length === 1) return base(asr[0].lang);
    return '';
  }

  function chooseSource(data) {
    const tracks = data.tracks || [];
    const target = settings.targetLang;
    const spoken = spokenLang(data);
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const asrs = tracks.filter((t) => t.kind === 'asr');
    const tn = langName(target);
    // 1. 已經有第一語言的人工字幕：直接用
    const direct = manual.find((t) => isTargetLang(t.lang, target));
    if (direct) return { type: 'direct', track: direct, spoken, label: `人工${tn}字幕` };
    // 2. 中文簡繁互轉（不用翻譯）
    if (base(target) === 'zh') {
      const zh = manual.find((t) => base(t.lang) === 'zh');
      if (zh) return { type: 'cc', track: zh, spoken, label: `人工中文字幕（轉${tn}）` };
    }
    // 3. 影片原本語言的人工字幕
    let orig = spoken ? manual.find((t) => base(t.lang) === spoken) : null;
    // 不知道影片語言時，才退而求其次用英文或第一條人工字幕
    if (!orig && !spoken) orig = manual.find((t) => base(t.lang) === 'en') || manual[0];
    if (orig) return { type: 'cc', track: orig, spoken, label: `人工字幕（${langName(orig.lang)}）＋翻譯` };
    // 4. YouTube 自動字幕：只用「影片原本語言」那條（其他語言的自動字幕通常是機器翻譯或配音用的，品質差）
    const asr = spoken ? asrs.find((t) => base(t.lang) === spoken) : (asrs.length === 1 ? asrs[0] : null);
    if (asr) return { type: 'cc', track: asr, auto: true, spoken, label: `YouTube 自動字幕（${langName(asr.lang)}）＋翻譯` };
    // 5. 沒有合適的字幕：本機辨識
    return { type: 'asr', spoken, label: `本機語音辨識（${spoken ? langName(spoken) : '自動偵測語言'}）＋翻譯` };
  }

  function restart() {
    if (cur) start(cur.vid, true);
  }

  async function start(vid, keepForce = false) {
    const my = ++seq;
    const force = keepForce && cur && cur.vid === vid ? cur.forceAsr : false;
    cur = { vid, cues: [], single: false, hideNative: false, source: '', forceAsr: force, helperUp: false, hasKey: false, jobStatus: '', statusText: '', hasCC: false, canForceAsr: false, summary: { status: 'none' } };
    lastShown = null;
    hideCard();
    setStatus('');
    if (!settings.enabled) return;
    const data = await page('getPlayerData', { videoId: vid });
    if (my !== seq) return;
    if (!data || !data.ok) { setStatus('讀不到影片資訊', 'error', 5000); return; }
    cur.title = data.title;
    const tracks = data.tracks || [];
    cur.hasCC = tracks.length > 0;
    if (data.isLive) {
      cur.source = '直播';
      setStatus('直播影片暫不支援，請改用 YouTube 字幕設定裡的「自動翻譯」', 'info', 8000);
      return;
    }
    let src = chooseSource(data);
    const spoken = src.spoken;
    if (cur.forceAsr) src = { type: 'asr', spoken, label: '本機語音辨識＋翻譯（手動切換）' };
    cur.source = src.label;
    cur.canForceAsr = src.type === 'cc' && !!src.auto;
    const hs = await send({ type: 'helperStatus' });
    if (my !== seq) return;
    cur.helperUp = !!(hs && hs.up);
    cur.hasKey = !!(hs && hs.hasKey);
    cur.helperOld = cur.helperUp && helperIsOld(hs.version);
    if (cur.helperOld) remindOldHelper(my, hs.version);
    else if (cur.helperUp) loadSummary(my);

    if (src.type === 'direct') {
      const r = await page('fetchTrack', { videoId: vid, baseUrl: src.track.baseUrl, lang: src.track.lang });
      if (my !== seq) return;
      if (!r.ok) { setStatus('抓不到字幕：' + r.error, 'error', 6000); return; }
      cur.cues = parseJson3(r.json, false).map((c) => ({ ...c, z: c.o }));
      cur.single = true;
      cur.hideNative = true;
      setStatus('使用' + src.label, 'ok', 3000);
      return;
    }

    if (!cur.helperUp || (src.type === 'cc' && hs && !hs.hasKey)) {
      maybeRemindIfDown(my, src);
      if (src.type === 'cc') return fallbackYouTube(my, src, hs && hs.up && !hs.hasKey);
      setStatus('沒有字幕：請開啟本機助手來辨識聲音', 'warn');
      return;
    }

    let body;
    if (src.type === 'cc') {
      setStatus('讀取字幕中…');
      const r = await page('fetchTrack', { videoId: vid, baseUrl: src.track.baseUrl, lang: src.track.lang });
      if (my !== seq) return;
      if (!r.ok) {
        // 抓不到 CC 就改用本機辨識
        src = { type: 'asr', spoken, label: '本機語音辨識＋翻譯（字幕讀取失敗）' };
        cur.source = src.label;
      } else {
        const cues = parseJson3(r.json, !!src.auto);
        cur.cues = cues.map((c) => ({ ...c }));
        cur.hideNative = true;
        body = {
          video_id: vid, kind: 'cc', title: data.title, lang: src.track.lang, target: settings.targetLang,
          source: `cc-${src.track.lang}-${src.auto ? 'auto' : 'm'}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60),
          cues: cues.map((c) => ({ s: c.s, e: c.e, t: c.o })),
        };
      }
    }
    if (src.type === 'asr') {
      const want = settings.sourceLang !== 'auto' ? settings.sourceLang : '';
      body = {
        video_id: vid, kind: 'asr', title: data.title, target: settings.targetLang,
        lang: want, hint: want ? '' : (spoken || ''), source: `asr-${want || 'auto'}`,
      };
      cur.hideNative = true;
    }
    runJob(my, body);
  }

  function maybeRemindIfDown(my, src) {
    if (!cur.helperUp) maybeRemind(my, src.type === 'cc');
  }

  // 本機助手沒開（或沒設定金鑰）時：用 YouTube 內建的自動翻譯
  async function fallbackYouTube(my, src, noKey) {
    setStatus('讀取字幕中…');
    const tr = src.track;
    const zhRes = await page('fetchTrack', { videoId: cur.vid, baseUrl: tr.baseUrl, lang: tr.lang, tlang: settings.targetLang });
    if (my !== seq) return;
    const oRes = zhRes.ok && !src.auto && !isTargetLang(tr.lang, settings.targetLang) && !(base(tr.lang) === 'zh' && base(settings.targetLang) === 'zh')
      ? await page('fetchTrack', { videoId: cur.vid, baseUrl: tr.baseUrl, lang: tr.lang }) : { ok: false };
    if (my !== seq) return;
    if (!zhRes.ok) { setStatus('抓不到字幕：' + zhRes.error, 'error', 6000); return; }
    const zh = parseJson3(zhRes.json, false);
    const origByStart = new Map();
    if (oRes.ok && !src.auto && base(tr.lang) !== 'zh') {
      for (const c of parseJson3(oRes.json, false)) origByStart.set(Math.round(c.s * 10), c.o);
    }
    const clean = (t) => (t || '').replace(/>>\s*/g, '').trim();
    cur.cues = zh.map((c) => ({ s: c.s, e: c.e, z: clean(c.o), o: clean(origByStart.get(Math.round(c.s * 10))) }));
    cur.single = origByStart.size === 0;
    cur.hideNative = true;
    cur.source = src.label.replace('＋翻譯', '') + '＋YouTube 內建翻譯';
    setStatus(noKey ? '尚未設定 Groq 金鑰，先用 YouTube 內建翻譯（到設定頁輸入金鑰）' : '使用 YouTube 內建翻譯（本機助手未開啟）', noKey ? 'warn' : 'info', 6000);
  }

  async function runJob(my, body) {
    const isAsr = body.kind === 'asr';
    setStatus(isAsr ? '準備辨識中…' : '翻譯中…');
    const r = await send({ type: 'createJob', body });
    if (my !== seq) return;
    if (!r || !r.ok) {
      if (r && r.down) { cur.helperUp = false; maybeRemind(my, !isAsr); }
      setStatus('本機助手錯誤：' + ((r && r.error) || '沒有回應'), 'error', 8000);
      return;
    }
    cur.fresh = true;       // 本機助手回傳字幕後，改以它的內容為準（在那之前先顯示原本的字幕）
    let snap = r.data;
    const jobId = snap.id;
    let rev = 0;
    let fails = 0;
    for (;;) {
      if (my !== seq) return;
      rev = applySnap(snap, rev);
      if (['done', 'error', 'cancelled'].includes(snap.status)) break;
      await sleep(cur.cues.length ? 1500 : 800);
      if (my !== seq) return;
      const v = video();
      const p = await send({ type: 'pollJob', id: jobId, since: rev, pos: v ? v.currentTime : 0 });
      if (my !== seq) return;
      if (!p || !p.ok) {
        if (++fails >= 5) { setStatus('本機助手沒有回應，可能已被關閉', 'error'); cur.helperUp = false; return; }
        continue;
      }
      fails = 0;
      snap = p.data;
    }
  }

  function applySnap(snap, rev) {
    cur.jobStatus = snap.status;
    cur.single = !!snap.single;
    if (snap.cues && snap.cues.length) {
      if (cur.fresh) { cur.cues = []; cur.fresh = false; }
      for (const c of snap.cues) cur.cues[c.i] = { s: c.s, e: c.e, o: c.o, z: c.z };
      cur.cues = cur.cues.filter(Boolean);
    }
    // 本機助手重新辨識（例如顯示卡出錯後重來）時字幕會變少：去掉多出來的舊字幕
    if (!cur.fresh && Number.isInteger(snap.total) && cur.cues.length > snap.total) cur.cues.length = snap.total;
    const pct = Math.round((snap.progress || 0) * 100);
    const tr = snap.total ? `翻譯 ${snap.translated}/${snap.total}` : '';
    let text = '';
    let kind = 'info';
    switch (snap.status) {
      case 'queued': text = '排隊中…'; break;
      case 'downloading': text = '下載影片聲音中…'; break;
      case 'transcribing': text = `辨識中 ${pct}%` + (tr ? `・${tr}` : ''); break;
      case 'translating': text = tr ? `翻譯中 ${snap.translated}/${snap.total}` : '翻譯中…'; break;
      case 'done': text = '字幕已就緒'; kind = 'ok'; break;
      case 'error': text = snap.error || '發生錯誤'; kind = 'error'; break;
      case 'cancelled': text = '已停止'; break;
    }
    if (snap.note && snap.status !== 'done' && snap.status !== 'error') text += `（${snap.note}）`;
    if (snap.warn && snap.status !== 'error') { text += `・${snap.warn}`; if (kind === 'info') kind = 'warn'; }
    // 卡住偵測：進度超過 3 分鐘完全沒變，就顯示錯誤（仍繼續等，有進度會自動恢復）
    const sig = [snap.status, pct, snap.translated, snap.total, snap.note, snap.rev].join('|');
    if (sig !== cur.lastSig) { cur.lastSig = sig; cur.lastSigAt = Date.now(); }
    else if (!['done', 'error', 'cancelled'].includes(snap.status) && Date.now() - cur.lastSigAt > 180000) {
      text = '處理超過 3 分鐘沒有進度，可能卡住了。可以到擴充功能小視窗確認本機助手狀態，或重新整理頁面再試';
      kind = 'error';
    }
    setStatus(text, kind, snap.status === 'done' ? 3000 : snap.status === 'error' ? 12000 : 0);
    return snap.rev || rev;
  }

  // ───────── 右側面板：字幕列表＋大綱摘要 ─────────
  const panelState = { tab: 'subs', collapsed: false };
  let panel = null;
  let panelSig = '';         // 字幕列表的組成（換影片、句數、顯示方式）改變時整個重畫
  let sumSig = '';
  let panelActive = -1;
  let sumActive = -1;
  let lastPanelAt = 0;
  let userScrollUntil = 0;   // 使用者自己捲動字幕列表時，暫停自動捲動到這個時間

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function seek(t) {
    const v = video();
    if (v && Number.isFinite(t)) v.currentTime = Math.max(0, t);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = el('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
    }
    if (!btn) return;
    clearTimeout(btn._t);
    btn.classList.toggle('done', ok);
    if (btn.dataset.label) btn.textContent = ok ? '已複製 ✓' : '複製失敗';
    btn._t = setTimeout(() => {
      btn.classList.remove('done');
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }, 1500);
  }

  function savePanelState() {
    chrome.storage.local.set({ panelTab: panelState.tab, panelCollapsed: panelState.collapsed });
  }

  function panelHost() {
    const sec = document.querySelector('ytd-watch-flexy #secondary-inner') || document.querySelector('ytd-watch-flexy #secondary');
    if (sec && sec.offsetWidth > 0) return { host: sec, first: true };
    // 視窗太窄時 YouTube 不顯示右側欄：改放在影片標題下方的區塊最上面
    const below = document.querySelector('ytd-watch-flexy #below');
    return below ? { host: below, first: true } : null;
  }

  function buildPanel() {
    const root = el('section', 'ytsub-panel');
    root.setAttribute('aria-label', 'YT 字幕翻譯：字幕與大綱');
    root.innerHTML = `
      <div class="ytsub-p-head">
        <div class="ytsub-p-tabs" role="tablist">
          <button type="button" role="tab" data-tab="subs">字幕</button>
          <button type="button" role="tab" data-tab="sum">大綱</button>
        </div>
        <span class="ytsub-p-lang"></span>
        <button type="button" class="ytsub-p-copy" data-label="複製全部">複製全部</button>
        <button type="button" class="ytsub-p-fold"></button>
      </div>
      <div class="ytsub-p-body">
        <div class="ytsub-p-scroll ytsub-p-subs" tabindex="0" aria-label="字幕列表">
          <div class="ytsub-p-empty"></div>
          <div class="ytsub-p-list"></div>
        </div>
        <button type="button" class="ytsub-p-resume">回到目前播放位置</button>
        <div class="ytsub-p-scroll ytsub-p-sum" aria-label="大綱摘要"></div>
      </div>`;
    const q = (s) => root.querySelector(s);
    const pn = {
      root, tabs: [...root.querySelectorAll('[role=tab]')], lang: q('.ytsub-p-lang'), copy: q('.ytsub-p-copy'),
      fold: q('.ytsub-p-fold'), subs: q('.ytsub-p-subs'), empty: q('.ytsub-p-empty'), list: q('.ytsub-p-list'),
      resume: q('.ytsub-p-resume'), sum: q('.ytsub-p-sum'), items: [],
    };
    // 面板裡的按鍵不要被 YouTube 當成快捷鍵（例如空白鍵暫停、方向鍵快轉）
    root.addEventListener('keydown', (e) => e.stopPropagation());
    for (const t of pn.tabs) {
      t.addEventListener('click', () => {
        panelState.tab = t.dataset.tab;
        panelState.collapsed = false;
        savePanelState();
        sumSig = '';
        panelActive = -1;
        updatePanel(true);
      });
    }
    pn.fold.addEventListener('click', () => {
      panelState.collapsed = !panelState.collapsed;
      savePanelState();
      panelActive = -1;
      updatePanel(true);
    });
    pn.copy.addEventListener('click', () => {
      const text = panelState.tab === 'sum' ? summaryText() : subsText();
      if (text) copyText(text, pn.copy);
    });
    // 使用者自己捲動時，先暫停自動捲動
    const pause = () => { userScrollUntil = Date.now() + 5000; };
    for (const ev of ['wheel', 'touchmove', 'pointerdown']) pn.subs.addEventListener(ev, pause, { passive: true });
    pn.subs.addEventListener('keydown', (e) => { if (/Arrow|Page|Home|End|^ $/.test(e.key)) pause(); });
    pn.resume.addEventListener('click', () => { userScrollUntil = 0; panelActive = -1; updatePanel(true); });
    pn.list.addEventListener('click', (e) => {
      const line = e.target.closest('.ytsub-line');
      if (!line || !cur) return;
      const c = cur.cues[+line.dataset.i];
      if (!c) return;
      const btn = e.target.closest('.ytsub-line-copy');
      if (btn) {
        e.stopPropagation();
        const it = pn.items[+line.dataset.i];
        copyText([it.z, it.o].filter(Boolean).join('\n'), btn);
        return;
      }
      userScrollUntil = 0;
      seek(c.s);
    });
    pn.sum.addEventListener('click', (e) => {
      const b = e.target.closest('[data-seek]');
      if (b) { seek(+b.dataset.seek); return; }
      const g = e.target.closest('.ytsub-sum-gen');
      if (!g) return;
      if (g.classList.contains('ytsub-sum-restart')) restartHelper(g, seq);
      else genSummary();
    });
    return pn;
  }

  function ensurePanel() {
    if (!settings.enabled || location.pathname !== '/watch' || !cur) {
      if (panel) panel.root.remove();
      return null;
    }
    const h = panelHost();
    if (!h) return null;
    if (!panel) panel = buildPanel();
    if (panel.root.parentNode !== h.host) {
      h.host.prepend(panel.root);
      panelActive = -1;
    }
    return panel;
  }

  // 每句要顯示的兩行：翻譯（大字）＋原文（小字），規則跟播放器上的字幕一樣
  function lineTexts(c, zhOnly) {
    const z = (c.z || '').trim();
    if (z) return { z, o: zhOnly ? '' : (c.o || '').trim() };
    return { z: '', o: (c.o || '').trim() };
  }

  function updatePanel(force) {
    const now = Date.now();
    if (!force && now - lastPanelAt < 250) return;
    lastPanelAt = now;
    const pn = ensurePanel();
    if (!pn) return;
    pn.root.classList.toggle('collapsed', panelState.collapsed);
    for (const t of pn.tabs) t.setAttribute('aria-selected', String(t.dataset.tab === panelState.tab));
    const foldLabel = panelState.collapsed ? '展開面板' : '收合面板';
    pn.fold.textContent = panelState.collapsed ? '▸' : '▾';
    pn.fold.title = foldLabel;
    pn.fold.setAttribute('aria-label', foldLabel);
    pn.fold.setAttribute('aria-expanded', String(!panelState.collapsed));
    pn.lang.textContent = langName(settings.targetLang);
    const isSubs = panelState.tab === 'subs';
    pn.subs.hidden = !isSubs;
    pn.sum.hidden = isSubs;
    if (!isSubs) pn.resume.classList.remove('show');
    if (panelState.collapsed) return;
    if (isSubs) updateSubs(pn); else updateSum(pn);
  }

  function updateSubs(pn) {
    const cues = cur.cues;
    const zhOnly = cur.single || settings.display === 'zh';
    pn.copy.disabled = !cues.length;
    if (!cues.length) {
      pn.empty.textContent = cur.statusText || '正在準備字幕…';
      pn.empty.hidden = false;
      if (panelSig) { pn.list.textContent = ''; pn.items = []; panelSig = ''; }
      pn.resume.classList.remove('show');
      return;
    }
    pn.empty.hidden = true;
    const sig = `${cur.vid}|${cues.length}|${zhOnly}`;
    if (sig !== panelSig) {
      panelSig = sig;
      panelActive = -1;
      pn.list.textContent = '';
      pn.items = [];
      const frag = document.createDocumentFragment();
      cues.forEach((c, i) => {
        const line = el('div', 'ytsub-line');
        line.dataset.i = i;
        const time = el('span', 'ytsub-line-time', fmtTime(c.s));
        const tx = el('div', 'ytsub-line-text');
        const z = el('div', 'ytsub-line-z');
        const o = el('div', 'ytsub-line-o');
        z.dir = 'auto';
        o.dir = 'auto';
        tx.append(z, o);
        const cp = el('button', 'ytsub-line-copy', '⧉');
        cp.type = 'button';
        cp.title = '複製這句';
        cp.setAttribute('aria-label', '複製這句');
        line.append(time, tx, cp);
        frag.append(line);
        pn.items.push({ line, zEl: z, oEl: o, z: null, o: null });
      });
      pn.list.append(frag);
    }
    // 翻譯陸續完成時，只更新有變的句子
    cues.forEach((c, i) => {
      const it = pn.items[i];
      const t = lineTexts(c, zhOnly);
      if (t.z === it.z && t.o === it.o) return;
      it.z = t.z;
      it.o = t.o;
      it.zEl.textContent = t.z;
      it.oEl.textContent = t.o;
      it.zEl.hidden = !t.z;
      it.oEl.hidden = !t.o;
      it.line.classList.toggle('pending', !t.z);
    });
    const v = video();
    const idx = v ? lastStarted(cues, v.currentTime) : -1;
    const paused = Date.now() < userScrollUntil;
    pn.resume.classList.toggle('show', paused && idx >= 0);
    if (idx === panelActive && !(panelActive >= 0 && !paused && pn.needScroll)) return;
    if (pn.items[panelActive]) pn.items[panelActive].line.classList.remove('active');
    panelActive = idx;
    const cur2 = pn.items[idx];
    if (!cur2) return;
    cur2.line.classList.add('active');
    pn.needScroll = paused;     // 暫停期間換句：恢復自動捲動後要補捲一次
    if (!paused) {
      const box = pn.subs;
      const top = cur2.line.offsetTop - box.clientHeight / 2 + cur2.line.offsetHeight / 2;
      box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  function subsText() {
    if (!cur || !cur.cues.length) return '';
    const zhOnly = cur.single || settings.display === 'zh';
    const out = cur.cues.map((c) => {
      const t = lineTexts(c, zhOnly);
      return `[${fmtTime(c.s)}] ${t.z || t.o}` + (t.z && t.o ? `\n${t.o}` : '');
    });
    return (cur.title ? cur.title + '\n\n' : '') + out.join(zhOnly ? '\n' : '\n\n');
  }

  // ── 大綱 ──
  function summaryReady() {
    // 先讓播放器上的字幕翻完，再整理大綱（兩者共用 Groq 額度，大綱會搶走翻譯的速度）
    return cur.cues.length > 0 && !['queued', 'downloading', 'transcribing', 'translating'].includes(cur.jobStatus);
  }

  function updateSum(pn) {
    const sm = cur.summary || { status: 'none' };
    const ready = summaryReady();
    pn.copy.disabled = sm.status !== 'done';
    const sig = [cur.vid, settings.targetLang, sm.status, sm.note, sm.error, sm.data && sm.data.created, cur.helperUp, cur.helperOld, cur.hasKey, ready].join('|');
    if (sig !== sumSig) {
      sumSig = sig;
      sumActive = -1;
      pn.sum.textContent = '';
      if (sm.status === 'done' && sm.data) renderSummary(pn.sum, sm.data);
      else pn.sum.append(summaryMessage(sm, ready));
    }
    if (sm.status !== 'done') return;
    // 目前播放到的段落加上標示
    const v = video();
    const cards = pn.sum.querySelectorAll('.ytsub-sec');
    const t = v ? v.currentTime : 0;
    let idx = -1;
    cards.forEach((c, i) => { if (+c.dataset.s <= t + 0.5) idx = i; });
    if (idx === sumActive) return;
    if (cards[sumActive]) cards[sumActive].classList.remove('active');
    sumActive = idx;
    if (cards[idx]) cards[idx].classList.add('active');
  }

  function summaryMessage(sm, ready) {
    const box = el('div', 'ytsub-sum-msg');
    const p = (t) => box.append(el('p', '', t));
    const gen = (text, disabled) => {
      const b = el('button', 'ytsub-sum-gen', text);
      b.type = 'button';
      b.disabled = !!disabled;
      box.append(b);
    };
    if (sm.status === 'running') {
      box.classList.add('busy');
      p('大綱整理中' + (sm.note ? `：${sm.note}` : '…'));
      p('長影片會分段整理，需要一點時間。整理好會存在電腦裡，下次打開這部影片就直接顯示。');
      return box;
    }
    if (!cur.helperUp) {
      p('大綱由本機助手用你的 Groq 金鑰整理，請先開啟本機助手（雙擊 start-helper.bat）。');
      return box;
    }
    if (cur.helperOld) {
      p('電腦上的本機助手是舊版，還沒有大綱功能。重新啟動後就能使用（進行中的辨識會重新開始）。');
      const b = el('button', 'ytsub-sum-gen ytsub-sum-restart', '重新啟動本機助手');
      b.type = 'button';
      box.append(b);
      return box;
    }
    if (!cur.hasKey) {
      p('還沒設定 Groq 金鑰：請按 Chrome 工具列的「YT 字幕翻譯」圖示 →「設定」輸入金鑰。');
      return box;
    }
    if (sm.status === 'error') {
      box.classList.add('error');
      p('產生大綱失敗：' + (sm.error || '未知錯誤'));
      gen('再試一次', !ready);
      return box;
    }
    p(`把整部影片整理成幾個段落：每段有時間、小標題與重點，內容使用${langName(settings.targetLang)}。`);
    if (!ready) p('播放器上的字幕翻譯完成後，就能產生大綱。');
    gen('產生大綱', !ready);
    return box;
  }

  function renderSummary(box, data) {
    if (data.overview) {
      const ov = el('div', 'ytsub-sum-ov');
      ov.append(el('div', 'ytsub-sum-label', '總覽'), el('p', '', data.overview));
      box.append(ov);
    }
    const ol = el('ol', 'ytsub-sum-list');
    for (const s of data.sections || []) {
      const li = el('li', 'ytsub-sec');
      li.dataset.s = s.start;
      const tb = el('button', 'ytsub-sec-time', fmtTime(s.start));
      tb.type = 'button';
      tb.dataset.seek = s.start;
      tb.title = '跳到 ' + fmtTime(s.start);
      const body = el('div', 'ytsub-sec-body');
      const title = el('button', 'ytsub-sec-title', s.title || fmtTime(s.start));
      title.type = 'button';
      title.dataset.seek = s.start;
      body.append(title);
      if (s.points && s.points.length) {
        const ul = el('ul', 'ytsub-sec-points');
        for (const pt of s.points) ul.append(el('li', '', pt));
        body.append(ul);
      }
      li.append(tb, body);
      ol.append(li);
    }
    box.append(ol);
  }

  function summaryText() {
    const d = cur && cur.summary && cur.summary.data;
    if (!d) return '';
    let out = cur.title ? cur.title + '\n\n' : '';
    if (d.overview) out += `總覽：${d.overview}\n\n`;
    out += (d.sections || []).map((s) => `[${fmtTime(s.start)}] ${s.title}` + (s.points || []).map((p) => `\n  • ${p}`).join('')).join('\n\n');
    return out;
  }

  // 開影片時看看有沒有做好的大綱（或正在整理中的）
  async function loadSummary(my) {
    const r = await send({ type: 'getSummary', vid: cur.vid, target: settings.targetLang });
    if (my !== seq || !r || !r.ok) return;
    pollSummary(my, r.data);
  }

  async function genSummary() {
    if (!cur || !summaryReady()) return;
    const my = seq;
    cur.summary = { status: 'running', note: '準備中' };
    updatePanel(true);
    const body = {
      video_id: cur.vid, target: settings.targetLang, title: cur.title || '',
      cues: cur.cues.map((c) => ({ s: c.s, t: (c.o || c.z || '').trim() })).filter((c) => c.t),
    };
    const r = await send({ type: 'startSummary', body });
    if (my !== seq) return;
    if (!r || !r.ok) {
      if (r && r.down) cur.helperUp = false;
      if (r && r.status === 404) { cur.helperOld = true; cur.summary = { status: 'none' }; return; }   // 舊版助手沒有大綱功能
      cur.summary = { status: 'error', error: (r && r.error) || '本機助手沒有回應' };
      return;
    }
    pollSummary(my, r.data);
  }

  async function pollSummary(my, st) {
    let fails = 0;
    for (;;) {
      if (my !== seq || !cur) return;
      cur.summary = st || { status: 'none' };
      if (cur.summary.status !== 'running') return;
      await sleep(2000);
      if (my !== seq || !cur) return;
      const r = await send({ type: 'getSummary', vid: cur.vid, target: settings.targetLang });
      if (my !== seq) return;
      if (r && r.ok) { st = r.data; fails = 0; continue; }
      if (++fails >= 5) { st = { status: 'error', error: '本機助手沒有回應，可能已被關閉' }; }
    }
  }

  // ───────── 偵測換影片 ─────────
  function currentVid() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }
  function checkNav() {
    const vid = currentVid();
    if (!vid) {
      if (cur) { seq++; cur = null; hideCard(); setStatus(''); }
      return;
    }
    if (!cur || cur.vid !== vid) start(vid);
  }
  document.addEventListener('yt-navigate-finish', () => setTimeout(checkNav, 300));
  setInterval(checkNav, 1000);

  // ───────── 設定 ─────────
  chrome.storage.local.get([...Object.keys(DEFAULTS), 'panelTab', 'panelCollapsed'], (s) => {
    settings = { ...DEFAULTS, ...s };
    if (s.panelTab === 'sum') panelState.tab = 'sum';
    panelState.collapsed = !!s.panelCollapsed;
    applyStyle();
    checkNav();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    const wasEnabled = settings.enabled;
    for (const k of Object.keys(DEFAULTS)) if (ch[k]) settings[k] = ch[k].newValue;
    applyStyle();
    lastShown = null;
    panelSig = '';
    if ((ch.targetLang || ch.sourceLang) && settings.enabled && cur) start(cur.vid, true);
    if (ch.enabled && settings.enabled !== wasEnabled) {
      if (settings.enabled) { if (cur) start(cur.vid, true); else checkNav(); }
      else { seq++; hideCard(); setStatus(''); }
    }
  });

  // ───────── 給彈出視窗用 ─────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'getState') {
      sendResponse(cur ? {
        vid: cur.vid, title: cur.title, source: cur.source, status: cur.statusText, kind: cur.statusKind,
        helperUp: cur.helperUp, canForceAsr: cur.canForceAsr && !cur.forceAsr, cues: cur.cues.length,
      } : { vid: null });
    } else if (msg.type === 'forceAsr') {
      if (cur) { cur.forceAsr = true; start(cur.vid, true); }
      sendResponse({ ok: true });
    } else if (msg.type === 'reload') {
      if (cur) start(cur.vid, true);
      sendResponse({ ok: true });
    }
  });
})();
