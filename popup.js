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
  let handle;
  try {
    // The id makes Chrome reopen this dialog in the folder last used with it.
    handle = await showSaveFilePicker({ id: 'justsave', suggestedName: name, types: [TYPES[format]] });
  } catch {
    return window.close(); // dialog cancelled
  }
  // Stay open during capture: only this page holds write permission for the picked file.
  document.body.textContent = 'Saving…';
  if (await chrome.runtime.sendMessage({ format, tab, name })) {
    try {
      const w = await handle.createWritable();
      await w.write(await idb('readonly', s => s.get(tab.id)));
      await w.close();
      await idb('readwrite', s => s.delete(tab.id));
    } catch (e) {
      console.error(e);
      await chrome.runtime.sendMessage({ fallback: true, tab, name }); // don't lose the capture
    }
  }
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
