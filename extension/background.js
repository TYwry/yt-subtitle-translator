// 背景程式：負責跟電腦上的「本機助手」溝通（只連 127.0.0.1）。
const NATIVE = 'com.ty.ytsub_helper';
const DEFAULT_PORT = 8765;

async function getConn() {
  const s = await chrome.storage.local.get(['helperPort', 'helperToken']);
  return { port: s.helperPort || DEFAULT_PORT, token: s.helperToken || '' };
}

function native(cmd) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE, { cmd }, (res) => {
        if (chrome.runtime.lastError || !res) {
          resolve({ ok: false, nativeMissing: true, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || '啟動器沒有回應' });
        } else resolve(res);
      });
    } catch (e) {
      resolve({ ok: false, nativeMissing: true, error: String(e) });
    }
  });
}

async function saveConn(res) {
  if (res && res.token) await chrome.storage.local.set({ helperToken: res.token, helperPort: res.port || DEFAULT_PORT });
}

async function timedFetch(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

async function ping() {
  const { port } = await getConn();
  try {
    const r = await timedFetch(`http://127.0.0.1:${port}/ping`, {}, 1500);
    if (!r.ok) return { up: false };
    const j = await r.json();
    return j.app === 'ytsub-helper' ? { up: true, model: j.model, hasKey: j.has_key, version: j.version || '' } : { up: false };
  } catch (e) {
    return { up: false };
  }
}

async function api(method, path, body, retry = true) {
  let { port, token } = await getConn();
  if (!token) {
    await saveConn(await native('token'));
    ({ port, token } = await getConn());
  }
  let r;
  try {
    r = await timedFetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Ytsub-Token': token },
      body: body ? JSON.stringify(body) : undefined,
    }, 15000);
  } catch (e) {
    return { ok: false, down: true, error: '本機助手沒有回應' };
  }
  if (r.status === 403 && retry) {
    const res = await native('token');           // 通行碼可能換過，重新取得一次
    if (res.ok) {
      await saveConn(res);
      return api(method, path, body, false);
    }
  }
  let j = {};
  try { j = await r.json(); } catch (e) { /* 忽略 */ }
  if (!r.ok) return { ok: false, status: r.status, error: j.error || `HTTP ${r.status}` };
  return { ok: true, data: j };
}

// 擴充功能更新後，本機助手可能還在跑舊版：結束它再開新版
async function restartHelper() {
  const res = await native('restart');
  if (res.token) await saveConn(res);
  if (!res.ok) return { ok: false, nativeMissing: !!res.nativeMissing, error: res.error || '重新啟動失敗' };
  return { ok: true, version: res.version || '' };
}

async function startHelper() {
  const res = await native('start');
  if (res.token) await saveConn(res);
  if (!res.ok) return { ok: false, nativeMissing: !!res.nativeMissing, error: res.error || '啟動失敗' };
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'helperStatus': return ping();
      case 'startHelper': return startHelper();
      case 'restartHelper': return restartHelper();
      case 'createJob': return api('POST', '/jobs', msg.body);
      case 'pollJob': return api('GET', `/jobs/${encodeURIComponent(msg.id)}?since=${msg.since || 0}&pos=${Number(msg.pos) || 0}`);
      case 'startSummary': return api('POST', '/summary', msg.body);
      case 'getSummary': return api('GET', `/summary?video_id=${encodeURIComponent(msg.vid)}&target=${encodeURIComponent(msg.target)}`);
      case 'getConfig': return api('GET', '/config');
      case 'setConfig': return api('POST', '/config', msg.body);
      case 'dismissReminder':
        await chrome.storage.session.set({ reminderDismissed: true });
        return { ok: true };
      case 'reminderDismissed': {
        const s = await chrome.storage.session.get('reminderDismissed');
        return { dismissed: !!s.reminderDismissed };
      }
      default: return { ok: false, error: 'unknown' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
