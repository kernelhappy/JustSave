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
const { name, note } = rec ?? {};
let png = rec?.blob; // replaced by Crop; Save, Download, Copy and Print all use the current one
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

// Zoom: 'fit' (whole capture), 'width', or a factor where 1 = actual size (one capture pixel per screen pixel).
// The fit modes never enlarge past actual size.
const shot = $('shot'), header = document.querySelector('header');
let zoom = 'width', scale = 1;
function applyZoom() {
  const w = shot.naturalWidth / devicePixelRatio, h = shot.naturalHeight / devicePixelRatio;
  if (!w) return;
  const fitW = Math.min(1, (document.documentElement.clientWidth - 32) / w);
  scale = zoom === 'fit' ? Math.min(fitW, (innerHeight - header.offsetHeight - 32) / h) : zoom === 'width' ? fitW : zoom;
  shot.style.width = w * scale + 'px';
  $('zoom').textContent = Math.round(scale * 100) + '%';
}
shot.onload = onresize = applyZoom;
$('zoombar').onclick = ({ target }) => {
  const z = target.dataset.zoom;
  if (!z) return;
  zoom = z === 'in' || z === 'out' ? Math.min(8, Math.max(0.05, scale * (z === 'in' ? 1.25 : 0.8))) : z;
  applyZoom();
};

// Crop: Crop starts a selection, a drag picks the area to keep, Enter or Apply crop keeps it, Esc cancels.
// Undo crop goes back to the full capture. ponytail: no handles to adjust the box; drag again to redo it.
let original, box;
const stage = $('stage'), sel = $('sel'), clamp = (v, max) => Math.min(max, Math.max(0, v));
function setShot(blob) {
  png = blob;
  URL.revokeObjectURL(shot.src);
  shot.src = URL.createObjectURL(blob);
  $('uncrop').hidden = !original;
}
function endCrop() {
  stage.classList.remove('cropping');
  sel.hidden = true;
  box = null;
  $('crop').textContent = 'Crop';
  $('status').textContent = '';
}
async function applyCrop() {
  const W = shot.naturalWidth, H = shot.naturalHeight;
  if (box) {
    const x = Math.floor(box.x), y = Math.floor(box.y), w = Math.min(W - x, Math.round(box.w)), h = Math.min(H - y, Math.round(box.h));
    if (w > 0 && h > 0) {
      const img = await createImageBitmap(png, x, y, w, h), c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(img, 0, 0);
      original ??= png;
      setShot(await c.convertToBlob({ type: 'image/png' }));
    }
  }
  endCrop();
}
$('crop').onclick = () => {
  if (stage.classList.contains('cropping')) return applyCrop();
  stage.classList.add('cropping');
  $('crop').textContent = 'Apply crop';
  $('status').textContent = 'Drag over the capture to pick the area to keep. Esc cancels.';
};
$('uncrop').onclick = () => { setShot(original); original = null; $('uncrop').hidden = true; };
onkeydown = e => {
  if (!stage.classList.contains('cropping')) return;
  if (e.key === 'Escape') endCrop();
  if (e.key === 'Enter') { e.preventDefault(); applyCrop(); }
};
// Box in capture pixels; the rect is re-read on every move so scrolling mid-drag still lines up.
stage.onpointerdown = e => {
  if (!stage.classList.contains('cropping') || e.button) return;
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  const at = ev => {
    const r = shot.getBoundingClientRect(), f = shot.naturalWidth / r.width;
    return [clamp((ev.clientX - r.left) * f, shot.naturalWidth), clamp((ev.clientY - r.top) * f, shot.naturalHeight)];
  };
  const [x0, y0] = at(e);
  stage.onpointermove = ev => {
    const [x1, y1] = at(ev), W = shot.naturalWidth, H = shot.naturalHeight;
    box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    // Percentages keep the box in place when the zoom changes.
    Object.assign(sel.style, { left: box.x / W * 100 + '%', top: box.y / H * 100 + '%', width: box.w / W * 100 + '%', height: box.h / H * 100 + '%' });
    sel.hidden = false;
  };
  stage.onpointerup = () => { stage.onpointermove = null; };
};
