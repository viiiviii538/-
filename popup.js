async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab.id;
}

async function ensureInjected(tabId) {
  try {
    await sendMsg(tabId, { type: "ping" });
    return;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await new Promise(r => setTimeout(r, 200));
  }
}

function sendMsg(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { scope: "mer-helper", ...msg }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      if (res?.ok) return resolve(res.result);
      reject(new Error(res?.error || "unknown error"));
    });
  });
}

async function call(type, payload) {
  const tabId = await getActiveTabId();
  await ensureInjected(tabId);
  return sendMsg(tabId, { type, payload });
}

document.getElementById('scanView').onclick = async () => {
  const soldOnly = document.getElementById('soldOnly').checked;
  const showBadges = document.getElementById('showBadges').checked;
  const result = await call('scan', { mode: 'view', soldOnly, showBadges });
  render(result);
};

document.getElementById('scanAll').onclick = async () => {
  const soldOnly = document.getElementById('soldOnly').checked;
  const showBadges = document.getElementById('showBadges').checked;
  const result = await call('scan', { mode: 'all', soldOnly, showBadges });
  render(result);
};

document.getElementById('toggleOverlay').onclick = async () => {
  await call('toggleOverlay');
};

function render(data) {
  const el = document.getElementById('result');
  if (!data) { el.textContent = '検索ページで実行してね。'; return; }
  const yen = n => '¥' + n.toLocaleString();
  el.textContent =
    `出品中: ${data.activeCount}\n` +
    `売り切れ: ${data.soldCount}\n` +
    `価格レンジ${data.soldOnly ? '(SOLDのみ)' : '(全件)'}: ` +
    (data.minPrice === null ? '-' : `${yen(data.minPrice)} 〜 ${yen(data.maxPrice)}`) +
    `\n取得件数: ${data.totalParsed}`;
}
