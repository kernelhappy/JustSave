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
let zoom = 'fit', scale = 1;
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

// Crop: Crop starts a selection. Drag to draw a box, then drag its handles to resize it or its inside to move it.
// Enter or Apply crop keeps it, Esc cancels. Undo crop goes back to the full capture.
let original, box; // box edges in capture pixels: { l, t, r, b }
const stage = $('stage'), sel = $('sel'), clamp = (v, max) => Math.min(max, Math.max(0, v));
const cropping = () => stage.classList.contains('cropping');
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
  if (box) {
    const x = Math.floor(box.l), y = Math.floor(box.t), w = Math.round(box.r) - x, h = Math.round(box.b) - y;
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
  if (cropping()) return applyCrop();
  stage.classList.add('cropping');
  $('crop').textContent = 'Apply crop';
  $('status').textContent = 'Drag over the capture, then adjust with the handles. Enter applies, Esc cancels.';
};
$('uncrop').onclick = () => { const o = original; original = null; setShot(o); };
onkeydown = e => {
  if (!cropping()) return;
  if (e.key === 'Escape') endCrop();
  if (e.key === 'Enter') { e.preventDefault(); applyCrop(); }
};
// Positions in capture pixels; the rect is re-read on every move so scrolling mid-drag still lines up.
stage.onpointerdown = e => {
  if (!cropping() || e.button) return;
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  const W = shot.naturalWidth, H = shot.naturalHeight;
  const at = ev => { const r = shot.getBoundingClientRect(), f = W / r.width; return [(ev.clientX - r.left) * f, (ev.clientY - r.top) * f]; };
  const [x0, y0] = at(e);
  // A handle drags its edges ('nw', 'e', ...), the box's inside moves it, anywhere else draws a new box from its 'se' corner.
  const fresh = !e.target.dataset.h && e.target !== sel, edges = fresh ? 'se' : e.target.dataset.h;
  const from = fresh ? { l: clamp(x0, W), t: clamp(y0, H), r: clamp(x0, W), b: clamp(y0, H) } : { ...box };
  stage.onpointermove = ev => {
    const [x, y] = at(ev), dx = x - x0, dy = y - y0;
    if (!edges) {
      const mx = Math.min(W - from.r, Math.max(-from.l, dx)), my = Math.min(H - from.b, Math.max(-from.t, dy));
      box = { l: from.l + mx, t: from.t + my, r: from.r + mx, b: from.b + my };
    } else {
      const l = edges.includes('w') ? clamp(from.l + dx, W) : from.l, r = edges.includes('e') ? clamp(from.r + dx, W) : from.r;
      const t = edges.includes('n') ? clamp(from.t + dy, H) : from.t, b = edges.includes('s') ? clamp(from.b + dy, H) : from.b;
      box = { l: Math.min(l, r), r: Math.max(l, r), t: Math.min(t, b), b: Math.max(t, b) }; // dragging past the far edge flips
    }
    // Percentages keep the box in place when the zoom changes.
    Object.assign(sel.style, { left: box.l / W * 100 + '%', top: box.t / H * 100 + '%', width: (box.r - box.l) / W * 100 + '%', height: (box.b - box.t) / H * 100 + '%' });
    sel.hidden = false;
  };
  stage.onpointerup = () => { stage.onpointermove = null; };
};
