const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Chrome blocks extension scripts on its own pages, the Web Store and (without file access) file:// pages.
// Full page needs them; Visible area falls back to a plain screenshot, which Chrome may still allow.
// The probe waits for the page to settle, so clicks are handled before it resolves; only Full page waits on it.
const blocked = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 0 }).then(() => false, () => true);

document.onclick = async ({ target }) => {
  const { mode } = target.dataset;
  if (!mode || (mode !== 'visible' && await blocked)) return;
  await chrome.runtime.sendMessage({ mode, tab });
  window.close();
};

if (await blocked) {
  for (const b of document.querySelectorAll('[data-mode=full], [data-mode=fast]')) b.disabled = true;
  document.getElementById('note').hidden = false;
}
