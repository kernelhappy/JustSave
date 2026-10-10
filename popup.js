document.onclick = async ({ target }) => {
  const { mode } = target.dataset;
  if (!mode) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ mode, tab });
  window.close();
};
