const $ = (id) => document.getElementById(id);
let tabId = null;

function tabSend(msg) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    chrome.tabs.sendMessage(tabId, msg, (res) => resolve(chrome.runtime.lastError ? null : res));
  });
}

async function refreshHelper() {
  const h = await chrome.runtime.sendMessage({ type: 'helperStatus' });
  const up = h && h.up;
  $('hDot').className = 'dot ' + (up ? 'on' : 'off');
  $('hText').textContent = up ? '執行中' : '未開啟';
  $('startHelper').hidden = !!up;
  if (up) {
    $('hMsg').className = 'msg muted';
    $('hMsg').textContent = h.model ? '語音模型：' + h.model : '';
  }
}

$('startHelper').addEventListener('click', async () => {
  const b = $('startHelper');
  b.disabled = true;
  b.textContent = '開啟中…';
  const r = await chrome.runtime.sendMessage({ type: 'startHelper' });
  b.disabled = false;
  b.textContent = '開啟';
  if (r && r.ok) {
    $('hMsg').className = 'msg ok';
    $('hMsg').textContent = '已開啟';
    await tabSend({ type: 'reload' });
  } else {
    $('hMsg').className = 'msg err';
    $('hMsg').textContent = '無法自動開啟：請到專案資料夾雙擊 start-helper.bat（第一次需要先安裝）。';
  }
  refreshHelper();
});

$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));

(async () => {
  const s = await chrome.storage.local.get({ enabled: true });
  $('enabled').checked = s.enabled;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 沒有「讀取分頁網址」的權限，所以不檢查網址；不是 YouTube 分頁時傳訊息會自動失敗、不影響
  if (tab) tabId = tab.id;
  refreshHelper();
})();
