// 在 YouTube 頁面本身執行：讀取播放器的字幕清單，並取得字幕內容。
// YouTube 會要求字幕請求附上驗證參數（pot），所以這裡會「旁聽」播放器自己發出的字幕請求，借用它的驗證參數。
(() => {
  if (window.__ytsubHook) return;
  window.__ytsubHook = true;
  const TAG = '__ytsub';
  const potByVideo = {}; // videoId -> { pot, potc, c }

  function remember(url) {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.includes('/api/timedtext')) return;
      const v = u.searchParams.get('v');
      const pot = u.searchParams.get('pot');
      if (v && pot) potByVideo[v] = { pot, potc: u.searchParams.get('potc') || '1', c: u.searchParams.get('c') || 'WEB' };
    } catch (e) { /* 忽略 */ }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try { remember(typeof input === 'string' ? input : input && input.url); } catch (e) { /* 忽略 */ }
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { remember(String(url)); } catch (e) { /* 忽略 */ }
    return origOpen.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player');

  function playerResponse() {
    const p = player();
    try {
      const r = p && p.getPlayerResponse && p.getPlayerResponse();
      if (r && r.videoDetails) return r;
    } catch (e) { /* 忽略 */ }
    return window.ytInitialPlayerResponse || null;
  }

  async function getPlayerData(videoId) {
    for (let i = 0; i < 40; i++) {
      const r = playerResponse();
      if (r && r.videoDetails && r.videoDetails.videoId === videoId) {
        const list = (r.captions && r.captions.playerCaptionsTracklistRenderer) || {};
        const tracks = (list.captionTracks || []).map((t) => ({
          baseUrl: t.baseUrl,
          lang: t.languageCode || '',
          kind: t.kind || '',
          vssId: t.vssId || '',
          name: (t.name && (t.name.simpleText || (t.name.runs || []).map((x) => x.text).join(''))) || '',
          translatable: !!t.isTranslatable,
        }));
        const d = r.videoDetails;
        // 影片原本的音軌語言（有 AI 配音的影片會有好幾條音軌，標記 audioIsDefault 的才是原音）
        let audioLang = '';
        for (const f of (r.streamingData && r.streamingData.adaptiveFormats) || []) {
          if (f.audioTrack && f.audioTrack.audioIsDefault && f.audioTrack.id) { audioLang = String(f.audioTrack.id).split('.')[0]; break; }
        }
        return {
          ok: true, videoId, title: d.title || '', isLive: !!d.isLive,
          lengthSeconds: Number(d.lengthSeconds || 0), tracks, audioLang,
        };
      }
      await sleep(250);
    }
    return { ok: false, error: '讀不到影片資訊' };
  }

  function buildUrl(baseUrl, videoId, tlang) {
    const u = new URL(baseUrl, location.origin);
    u.searchParams.set('fmt', 'json3');
    if (tlang) u.searchParams.set('tlang', tlang);
    const p = potByVideo[videoId];
    if (p) {
      u.searchParams.set('pot', p.pot);
      u.searchParams.set('potc', p.potc);
      u.searchParams.set('c', p.c);
    }
    return u.toString();
  }

  async function tryFetch(url) {
    try {
      const res = await origFetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || !text.trim()) return null;
      const j = JSON.parse(text);
      return j && j.events ? j : null;
    } catch (e) {
      return null;
    }
  }

  // 讓播放器自己請求一次字幕，以取得驗證參數；結束後還原使用者原本的字幕設定
  async function primePot(videoId, lang) {
    const p = player();
    if (!p || !p.setOption) return;
    let before = null;
    try { before = p.getOption && p.getOption('captions', 'track'); } catch (e) { /* 忽略 */ }
    document.documentElement.classList.add('ytsub-priming');
    try {
      try { p.loadModule && p.loadModule('captions'); } catch (e) { /* 忽略 */ }
      try { p.setOption('captions', 'track', { languageCode: lang }); } catch (e) { /* 忽略 */ }
      for (let i = 0; i < 24 && !potByVideo[videoId]; i++) await sleep(250);
    } finally {
      try {
        if (before && before.languageCode) p.setOption('captions', 'track', before);
        else { p.setOption('captions', 'track', {}); p.unloadModule && p.unloadModule('captions'); }
      } catch (e) { /* 忽略 */ }
      setTimeout(() => document.documentElement.classList.remove('ytsub-priming'), 300);
    }
  }

  async function fetchTrack(videoId, baseUrl, lang, tlang) {
    // 只抓 YouTube 自己的字幕網址，不帶登入資料去連其他網站
    try {
      const u = new URL(baseUrl, location.origin);
      if (u.origin !== location.origin || !u.pathname.startsWith('/api/timedtext')) return { ok: false, error: '字幕網址不正確' };
    } catch (e) {
      return { ok: false, error: '字幕網址不正確' };
    }
    let j = await tryFetch(buildUrl(baseUrl, videoId, tlang));
    if (j) return { ok: true, json: j };
    if (!potByVideo[videoId]) {
      await primePot(videoId, lang);
      j = await tryFetch(buildUrl(baseUrl, videoId, tlang));
      if (j) return { ok: true, json: j };
    }
    return { ok: false, error: '抓不到字幕內容' };
  }

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m[TAG] !== 'req') return;
    let res;
    try {
      if (m.type === 'getPlayerData') res = await getPlayerData(m.videoId);
      else if (m.type === 'fetchTrack') res = await fetchTrack(m.videoId, m.baseUrl, m.lang, m.tlang);
      else res = { ok: false, error: 'unknown' };
    } catch (e) {
      res = { ok: false, error: String(e && e.message || e) };
    }
    window.postMessage({ [TAG]: 'res', id: m.id, res }, '*');
  });
})();
