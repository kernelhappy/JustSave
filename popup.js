import { idb } from './idb.js';

const TYPES = {
  png: { description: 'PNG image', accept: { 'image/png': ['.png'] } },
  pdf: { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } },
};

document.onclick = async ({ target }) => {
  const { format } = target.dataset;
  if (!format) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = fileName(tab) + '.' + format;
  try {
    // The id makes Chrome reopen this dialog in the folder last used with it.
    const handle = await showSaveFilePicker({ id: 'justsave', suggestedName: name, types: [TYPES[format]] });
    await idb('readwrite', s => s.put(handle, tab.id));
  } catch {
    return window.close(); // dialog cancelled
  }
  await chrome.runtime.sendMessage({ format, tab, name });
  window.close();
};

// "261009104405 - www.ebay.com"
function fileName(tab) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map(p).join('');
  let host = '';
  try { host = new URL(tab.url).hostname; } catch {}
  return `${stamp} - ${host || tab.title || 'page'}`.replace(/[\\/:*?"<>|~\x00-\x1f]+/g, '_').slice(0, 120).replace(/[. ]+$/, '');
}
