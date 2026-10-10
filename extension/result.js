import { idb } from './idb.js';
import { canvasToPdf } from './pdf.js';

const TYPES = {
  png: { description: 'PNG image', mime: 'image/png' },
  jpg: { description: 'JPEG image', mime: 'image/jpeg' },
  pdf: { description: 'PDF document', mime: 'application/pdf' },
};
const $ = id => document.getElementById(id);

// One-shot handoff from the service worker: this page keeps the capture in memory.
// ponytail: reloading this tab loses the capture; keep the record until tab close if that bites.
const id = location.hash.slice(1);
const rec = await idb('readonly', s => s.get(id)).catch(console.error);
if (rec) idb('readwrite', s => s.delete(id));
const { blob: png, name, note } = rec ?? {};
if (png) {
  document.title = name;
  $('shot').src = URL.createObjectURL(png);
  $('status').textContent = note ?? '';
} else {
  $('status').textContent = 'This capture is no longer available.';
  for (const el of document.querySelectorAll('header button, header select')) el.disabled = true;
}

// Format and quality start as last picked; quality only applies to JPG and PDF.
const showQuality = () => { $('quality').hidden = $('format').value === 'png'; };
for (const el of [$('format'), $('quality')]) {
  if (localStorage[el.id]) el.value = localStorage[el.id];
  if (el.selectedIndex < 0) el.selectedIndex = 0;
  el.onchange = () => { localStorage[el.id] = el.value; showQuality(); };
}
showQuality();

async function encode(fmt) {
  if (fmt === 'png') return png;
  const quality = +$('quality').value;
  const img = await createImageBitmap(png), c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  return fmt === 'jpg' ? c.convertToBlob({ type: 'image/jpeg', quality }) : canvasToPdf(c, quality);
}

const ACTIONS = {
  // Pick first (needs the click's user activation), then encode and write.
  async save(fmt) {
    const { description, mime } = TYPES[fmt];
    // The id makes Chrome reopen this dialog in the folder last used with it.
    // No "All files" choice: the bytes are always encoded as fmt, whatever extension gets typed.
    const handle = await showSaveFilePicker({ id: 'justsave', suggestedName: `${name}.${fmt}`, types: [{ description, accept: { [mime]: ['.' + fmt] } }], excludeAcceptAllOption: true });
    const fresh = !(await handle.getFile()).size; // the picker creates a new file empty
    const w = await handle.createWritable();
    try {
      await w.write(await encode(fmt));
      await w.close();
    } catch (e) {
      // Don't leave an empty file behind; an existing file keeps its old contents.
      await w.abort().catch(() => {});
      if (fresh) await handle.remove().catch(() => {});
      throw e;
    }
    return 'Saved ' + handle.name;
  },
  // Goes through Chrome's downloads, so it lands in Downloads and shows in download history.
  async download(fmt) {
    await chrome.downloads.download({ url: URL.createObjectURL(await encode(fmt)), filename: `${name}.${fmt}` });
    return 'Downloaded';
  },
  // The clipboard only takes PNG images.
  async copy() {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return 'Copied as PNG';
  },
  print() {
    print();
    return '';
  },
};

// One action at a time: a second Save would hit "File picker already active", and encodes are heavy.
let busy = false;
document.onclick = async ({ target }) => {
  const act = ACTIONS[target.dataset.act];
  if (!act || !png || busy) return;
  busy = true;
  $('status').textContent = 'Working…';
  try {
    $('status').textContent = await act($('format').value);
  } catch (e) {
    $('status').textContent = e.name === 'AbortError' ? '' : 'Failed: ' + e.message;
  } finally {
    busy = false;
  }
};
