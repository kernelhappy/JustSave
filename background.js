import { idb } from './idb.js';

// Chrome canvas limits (per side, and total pixels); bigger captures are scaled down to fit.
const MAX_CANVAS = 32767, MAX_AREA = 268435456;
// Backstop for very large pages.
const MAX_FRAMES = 100;

chrome.runtime.onMessage.addListener(({ mode, tab }) => { capture(tab, mode === 'full'); });

// Capture the visible area or the full page, then open it in a result tab (save, download, copy, print).
async function capture(tab, full) {
  const badge = text => chrome.action.setBadgeText({ tabId: tab.id, text });
  const inPage = async (func, ...args) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;
  // captureVisibleTab grabs whatever tab is showing, so a tab switch would stitch in the wrong page.
  const checkActive = async () => { if (!(await chrome.tabs.get(tab.id)).active) throw new Error('Tab switched during capture'); };
  const name = fileName(tab);
  badge('...');
  let start = { x: 0, y: 0 };
  try {
    if (full) await inPage(block);
    // Page size at click time is the capture size, so infinite-scroll results loaded
    // while we scroll (eBay, feeds) are ignored instead of chased.
    start = await inPage(full ? scrollThrough : here);
    const x0 = full ? 0 : start.x, y0 = full ? 0 : start.y;
    const x1 = full ? start.w : x0 + 1, y1 = full ? start.h : y0 + 1;

    // Capture what's on screen one viewport at a time, left to right, then down;
    // no viewport resizing, so the page lays out as displayed.
    const frames = [];
    for (let y = y0, more = true; more && y < y1; ) {
      more = false;
      let nextY = y;
      for (let x = x0; x < x1 && frames.length < MAX_FRAMES; ) {
        const m = await inPage(scrollToXY, x, y);
        if (frames.some(f => f.x === m.x && f.y === m.y)) break; // scroll clamped at the edge: nothing new
        if (full) {
          await inPage(freeze, frames.length > 0);
          await sleep(600); // let content settle; captureVisibleTab is also rate-limited to 2/sec
        }
        await checkActive();
        const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        await checkActive();
        frames.push({ ...m, img: await createImageBitmap(await (await fetch(shot)).blob()) });
        more = true;
        // Overlap neighbours by 1px so each frame's (possibly blended) edge row is drawn over.
        x = m.x + m.vw - 1;
        nextY = m.y + m.vh - 1;
      }
      y = nextY;
    }

    // Stitch. Frame pixels per CSS px (devicePixelRatio x zoom); crop off both scrollbars.
    const s = frames[0].img.width / frames[0].iw;
    const cssW = Math.min(start.w, Math.max(...frames.map(f => f.x + f.vw))) - x0;
    const cssH = Math.min(start.h, Math.max(...frames.map(f => f.y + f.vh))) - y0;
    const k = Math.min(1, MAX_CANVAS / (cssW * s), MAX_CANVAS / (cssH * s), Math.sqrt(MAX_AREA / (cssW * s * cssH * s)));
    const px = v => Math.round(v * s * k);
    const canvas = new OffscreenCanvas(px(cssW), px(cssH)), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Crop to whole device pixels: at fractional scaling (125%, 150%) a partial row would blend in the scrollbar.
    for (const f of frames) {
      const sw = Math.floor(f.vw * s), sh = Math.floor(f.vh * s);
      ctx.drawImage(f.img, 0, 0, sw, sh, px(f.x - x0), px(f.y - y0), Math.round(sw * k), Math.round(sh * k));
    }

    const id = crypto.randomUUID(), blob = await canvas.convertToBlob({ type: 'image/png' });
    await idb('readwrite', st => st.put({ blob, name }, id));
    await chrome.tabs.create({ url: 'result.html#' + id, index: tab.index + 1, openerTabId: tab.id });
    badge('');
  } catch (e) {
    console.error(e);
    badge('ERR');
  } finally {
    inPage(restore, start.x, start.y).catch(() => {});
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// "261009104405 - www.ebay.com"
function fileName(tab) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map(p).join('');
  let host = '';
  try { host = new URL(tab.url).hostname; } catch {}
  return `${stamp} - ${host || tab.title || 'page'}`.replace(/[\\/:*?"<>|~\x00-\x1f]+/g, '_').slice(0, 120).replace(/[. ]+$/, '');
}

// --- Injected into the page (must be self-contained) ---

// Swallow clicks, scrolling and keys so the user can't disturb a full-page capture.
// The shield is transparent, so it never shows in the frames.
function block() {
  const shield = document.createElement('div');
  shield.id = 'justsave-shield';
  shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:wait;background:transparent';
  document.documentElement.append(shield);
  window.justsaveStop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  for (const t of ['wheel', 'keydown', 'touchmove']) addEventListener(t, window.justsaveStop, { capture: true, passive: false });
}

function here() {
  const d = document.documentElement;
  return { x: scrollX, y: scrollY, w: d.scrollWidth, h: d.scrollHeight };
}

// Scroll through the page (as tall as it is now) so lazy-loaded content loads;
// returns the original scroll position and the page size.
async function scrollThrough() {
  const x = scrollX, y = scrollY, w = document.documentElement.scrollWidth, h = document.documentElement.scrollHeight, wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && scrollY + innerHeight < h; i++) {
    scrollBy({ top: innerHeight, behavior: 'instant' });
    await wait(150);
  }
  return { x, y, w, h };
}

// vw/vh: the viewport without scrollbars (standards-mode pages); iw: with them, to scale the frame.
function scrollToXY(x, y) {
  scrollTo({ left: x, top: y, behavior: 'instant' });
  const d = document.documentElement;
  return { x: scrollX, y: scrollY, vw: d.clientWidth, vh: d.clientHeight, iw: innerWidth };
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

function restore(x, y) {
  document.getElementById('justsave-shield')?.remove();
  for (const t of ['wheel', 'keydown', 'touchmove']) removeEventListener(t, window.justsaveStop, { capture: true });
  for (const el of document.querySelectorAll('[data-justsave]')) {
    el.setAttribute('style', el.dataset.justsave);
    delete el.dataset.justsave;
  }
  scrollTo({ left: x, top: y, behavior: 'instant' });
}
