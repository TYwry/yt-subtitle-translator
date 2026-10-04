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
      if (cur && (w.s - cur.e > 1.0 || (cur.o.length >= 70 && w.s - cur.e > 0.4))) { cues.push(cur); cur = null; }
      if (!cur) cur = { s: w.s, e: end, o: '', z: '' };
      cur.o += (cur.o && !cjk.test(w.t[0]) && !/^\s/.test(w.t) ? ' ' : '') + w.t;
      cur.e = end;
      const txt = cur.o.trim();
      if (txt.length >= 130 || cur.e - cur.s >= 9 || (/[.?!。？！]["'”’」』)）]*$/.test(txt) && cur.e - cur.s >= 1.2)) {
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
  function findCue(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
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
  setInterval(render, 100);

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
    cur = { vid, cues: [], single: false, hideNative: false, source: '', forceAsr: force, helperUp: false, jobStatus: '', statusText: '', hasCC: false, canForceAsr: false };
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
  chrome.storage.local.get(Object.keys(DEFAULTS), (s) => {
    settings = { ...DEFAULTS, ...s };
    applyStyle();
    checkNav();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    const wasEnabled = settings.enabled;
    for (const k of Object.keys(DEFAULTS)) if (ch[k]) settings[k] = ch[k].newValue;
    applyStyle();
    lastShown = null;
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
