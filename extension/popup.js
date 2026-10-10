const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Chrome blocks extension scripts on its own pages, the Web Store and (without file access) file:// pages.
// Full page needs them; Visible area falls back to a plain screenshot, which Chrome may still allow.
if (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 0 }).then(() => false, () => true)) {
  for (const b of document.querySelectorAll('[data-mode=full], [data-mode=fast]')) b.disabled = true;
  document.getElementById('note').hidden = false;
}

document.onclick = async ({ target }) => {
  const { mode } = target.dataset;
  if (!mode) return;
  await chrome.runtime.sendMessage({ mode, tab });
  window.close();
};
