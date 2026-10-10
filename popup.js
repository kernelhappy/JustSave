document.onclick = async ({ target }) => {
  const { format } = target.dataset;
  if (!format) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ format, tab });
  window.close();
};
