const $ = (id) => document.getElementById(id);
// 設定頁上有對應欄位的選項（字級、雙語／只顯示第一語言目前沒有放在設定頁，維持預設值）
const DEFAULTS = { bottom: 8, bgOpacity: 55, remind: 'always', targetLang: 'zh-Hant', sourceLang: 'auto' };

function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}

function updatePreview() {
  const scale = 1;
  const bg = `rgba(8,8,8,${Number($('bgOpacity').value) / 100})`;
  const pz = document.querySelector('.preview .pz');
  const po = document.querySelector('.preview .po');
  pz.style.fontSize = 26 * scale + 'px';
  po.style.fontSize = 26 * 0.66 * scale + 'px';
  pz.style.background = po.style.background = bg;
  $('bottomVal').textContent = $('bottom').value + '%';
  $('bgVal').textContent = $('bgOpacity').value + '%';
}

async function loadLocal() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    if ($(k).type === 'checkbox') $(k).checked = !!s[k]; else $(k).value = s[k];
  }
  updatePreview();
  for (const k of Object.keys(DEFAULTS)) {
    $(k).addEventListener($(k).type === 'checkbox' ? 'change' : 'input', () => {
      updatePreview();
      const v = $(k).type === 'range' ? Number($(k).value) : $(k).type === 'checkbox' ? $(k).checked : $(k).value;
      chrome.storage.local.set({ [k]: v });
    });
  }
}

let cfg = null;
function renderHelper(up, model) {
  $('helperCard').classList.toggle('helper-off', !up);
  $('hDot').className = 'dot ' + (up ? 'on' : 'off');
  $('hText').textContent = up ? '執行中' : '未開啟';
  $('startHelper').hidden = up;
  $('hModel').textContent = up && model ? '語音模型：' + model : '';
}

async function loadHelper() {
  const h = await chrome.runtime.sendMessage({ type: 'helperStatus' });
  renderHelper(!!(h && h.up), h && h.model);
  if (!(h && h.up)) return;
  const r = await chrome.runtime.sendMessage({ type: 'getConfig' });
  if (!r || !r.ok) { showMsg($('cfgMsg'), '讀不到本機助手的設定：' + ((r && r.error) || ''), false); return; }
  applyCfg(r.data);
}

function applyCfg(c) {
  cfg = c;
  $('keyState').textContent = c.has_key ? '已設定' : '尚未設定';
  const sel = $('groqModel');
  sel.innerHTML = '';
  for (const m of c.groq_models || []) {
    const o = document.createElement('option');
    o.value = o.textContent = m;
    sel.append(o);
  }
  sel.value = c.groq_model;
  const days = String(c.cache_days);
  if (![...$('cacheDays').options].some((o) => o.value === days)) {
    const o = document.createElement('option');
    o.value = days; o.textContent = days + ' 天';
    $('cacheDays').append(o);
  }
  $('cacheDays').value = days;
  $('autostart').checked = !!c.autostart;
}

async function setCfg(body, msgEl, okText) {
  const r = await chrome.runtime.sendMessage({ type: 'setConfig', body });
  if (r && r.ok) { applyCfg(r.data); showMsg(msgEl, okText, true); return true; }
  showMsg(msgEl, '儲存失敗：' + ((r && r.error) || '本機助手沒有回應'), false);
  return false;
}

$('saveKey').addEventListener('click', async () => {
  const k = $('groqKey').value.trim();
  if (!k) { showMsg($('keyMsg'), '請先貼上金鑰', false); return; }
  if (await setCfg({ groq_key: k }, $('keyMsg'), '金鑰已加密儲存')) $('groqKey').value = '';
});
$('groqModel').addEventListener('change', (e) => setCfg({ groq_model: e.target.value }, $('cfgMsg'), '已儲存'));
$('cacheDays').addEventListener('change', (e) => setCfg({ cache_days: Number(e.target.value) }, $('cfgMsg'), '已儲存'));
$('autostart').addEventListener('change', (e) => setCfg({ autostart: e.target.checked }, $('cfgMsg'), e.target.checked ? '已設定開機自動啟動' : '已取消開機自動啟動'));
// 清除快取：先跳出確認視窗，寫清楚要刪幾筆、刪了不能救回；按「刪除」才真的清除
$('clearCache').addEventListener('click', () => {
  const n = cfg && Number.isFinite(cfg.cache_count) ? cfg.cache_count : null;
  $('clearText').textContent = (n === null ? '會刪除所有已存的影片字幕。' : `會刪除 ${n} 部影片的已存字幕。`)
    + '刪除後無法救回，下次看這些影片時需要重新翻譯（會再用到 Groq 額度）。';
  $('clearDlg').showModal();
});
$('clearCancel').addEventListener('click', () => $('clearDlg').close());
$('clearOk').addEventListener('click', async () => {
  $('clearDlg').close();
  await setCfg({ clear_cache: true }, $('cfgMsg'), '快取已清除');
});
$('startHelper').addEventListener('click', async () => {
  const b = $('startHelper');
  b.disabled = true; b.textContent = '開啟中…';
  const r = await chrome.runtime.sendMessage({ type: 'startHelper' });
  b.disabled = false; b.textContent = '開啟本機助手';
  if (!r || !r.ok) { $('hModel').textContent = '無法自動開啟：請到專案資料夾雙擊 start-helper.bat（第一次需要先安裝）。'; return; }
  loadHelper();
});

loadLocal();
loadHelper();
