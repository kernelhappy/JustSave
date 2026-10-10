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
const rec = await idb('readonly', s => s.get(id));
if (rec) idb('readwrite', s => s.delete(id));
else $('status').textContent = 'This capture is no longer available.';
const { blob: png, name } = rec ?? {};
if (png) {
  document.title = name;
  $('shot').src = URL.createObjectURL(png);
}

async function encode(fmt) {
  if (fmt === 'png') return png;
  const img = await createImageBitmap(png), c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  return fmt === 'jpg' ? c.convertToBlob({ type: 'image/jpeg', quality: 0.92 }) : canvasToPdf(c);
}

const ACTIONS = {
  // Pick first (needs the click's user activation), then encode and write.
  async save(fmt) {
    const { description, mime } = TYPES[fmt];
    // The id makes Chrome reopen this dialog in the folder last used with it.
    const handle = await showSaveFilePicker({ id: 'justsave', suggestedName: `${name}.${fmt}`, types: [{ description, accept: { [mime]: ['.' + fmt] } }] });
    const w = await handle.createWritable();
    await w.write(await encode(fmt));
    await w.close();
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

document.onclick = async ({ target }) => {
  const act = ACTIONS[target.dataset.act];
  if (!act || !png) return;
  $('status').textContent = 'Working…';
  try {
    $('status').textContent = await act($('format').value);
  } catch (e) {
    $('status').textContent = e.name === 'AbortError' ? '' : 'Failed: ' + e.message;
  }
};
