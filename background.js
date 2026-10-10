import { imagesToPdf, quietRow, PAGE_W, PAGE_H, MARGIN } from './pdf.js';
import { idb } from './idb.js';

// Canvas height limit in Chrome; taller pages are scaled down to fit.
const MAX_CANVAS = 32767;
// Backstop for very long pages.
const MAX_FRAMES = 100;

chrome.runtime.onMessage.addListener(({ format, tab, name }) => { save(tab, format, name); });

async function save(tab, format, name) {
  const badge = text => chrome.action.setBadgeText({ tabId: tab.id, text });
  const inPage = async (func, ...args) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;
  badge('...');
  let startY = 0;
  try {
    // Page height at click time is the capture height, so infinite-scroll results loaded
    // while we scroll (eBay, feeds) are ignored instead of chased.
    const start = await inPage(scrollThrough);
    startY = start.y;

    // Capture what's on screen one viewport at a time; no viewport resizing, so the page lays out as displayed.
    const frames = [];
    for (let y = 0; frames.length < MAX_FRAMES && y < start.h; ) {
      const m = await inPage(scrollToY, y);
      if (frames.length && m.y <= frames.at(-1).y) break; // couldn't scroll further: bottom reached
      await inPage(freeze, frames.length > 0);
      await sleep(600); // let content settle; captureVisibleTab is also rate-limited to 2/sec
      const img = await createImageBitmap(await (await fetch(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))).blob());
      frames.push({ ...m, img });
      y = m.y + m.vh;
    }

    // Stitch. Frame pixels per CSS px (devicePixelRatio x zoom); crop off the scrollbar.
    const last = frames.at(-1), s = last.img.width / last.iw, cssH = Math.min(start.h, last.y + last.vh);
    const k = Math.min(1, MAX_CANVAS / (cssH * s));
    const W = Math.floor(last.cw * s * k), H = Math.round(cssH * s * k);
    const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    for (const f of frames) ctx.drawImage(f.img, 0, 0, Math.floor(f.cw * s), f.img.height, 0, Math.round(f.y * s * k), W, Math.round(f.img.height * k));

    let blob;
    if (format === 'png') {
      blob = await canvas.convertToBlob({ type: 'image/png' });
    } else {
      // Paginate to Letter: each page is a band of the screenshot, cut at the least busy row in its bottom 20%.
      const pageH = Math.round(W * (PAGE_H - 2 * MARGIN) / (PAGE_W - 2 * MARGIN)), band = Math.round(pageH * 0.2);
      const pages = [];
      for (let top = 0; top < H; ) {
        let end = Math.min(top + pageH, H);
        if (end < H) end += quietRow(ctx.getImageData(0, end - band, W, band).data, W, band) - band;
        const page = new OffscreenCanvas(W, end - top);
        page.getContext('2d').drawImage(canvas, 0, top, W, end - top, 0, 0, W, end - top);
        pages.push({ jpg: bin(await (await page.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer()), w: W, h: end - top });
        top = end;
      }
      blob = new Blob([Uint8Array.from(imagesToPdf(pages), c => c.charCodeAt(0))], { type: 'application/pdf' });
    }

    // Write to the file picked in the popup; if that fails, don't lose the capture: download it instead.
    try {
      const w = await (await idb('readonly', s => s.get(tab.id))).createWritable();
      await w.write(blob);
      await w.close();
    } catch (e) {
      console.warn('Writing the picked file failed; saving to Downloads instead.', e);
      const url = `data:${blob.type};base64,` + btoa(bin(await blob.arrayBuffer()));
      await chrome.downloads.download({ url, filename: name });
    }
    badge('');
  } catch (e) {
    console.error(e);
    badge('ERR');
  } finally {
    inPage(restore, startY).catch(() => {});
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ArrayBuffer -> binary string (one char per byte), chunked to stay under argument limits.
function bin(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return s;
}

// --- Injected into the page (must be self-contained) ---

// Scroll through the page (as tall as it is now) so lazy-loaded content loads;
// returns the original scroll position and that height.
async function scrollThrough() {
  const y = scrollY, h = document.documentElement.scrollHeight, wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && scrollY + innerHeight < h; i++) {
    scrollBy({ top: innerHeight, behavior: 'instant' });
    await wait(150);
  }
  return { y, h };
}

function scrollToY(y) {
  scrollTo({ top: y, behavior: 'instant' });
  return { y: scrollY, vh: innerHeight, iw: innerWidth, cw: document.documentElement.clientWidth };
}

// Sticky elements become relative (stay in their normal spot instead of repeating);
// after the first frame, fixed elements (headers, chat buttons) are hidden so they appear once.
function freeze(hideFixed) {
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if (pos !== 'sticky' && !(hideFixed && pos === 'fixed')) continue;
    if (!('justsave' in el.dataset)) el.dataset.justsave = el.getAttribute('style') ?? '';
    if (pos === 'sticky') el.style.setProperty('position', 'relative', 'important');
    else el.style.setProperty('opacity', '0', 'important');
  }
}

function restore(y) {
  for (const el of document.querySelectorAll('[data-justsave]')) {
    el.setAttribute('style', el.dataset.justsave);
    delete el.dataset.justsave;
  }
  scrollTo({ top: y, behavior: 'instant' });
}
