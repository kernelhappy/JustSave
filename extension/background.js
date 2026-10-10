import { idb } from './idb.js';

// Chrome canvas limits (per side, and total pixels); bigger captures are scaled down to fit.
const MAX_CANVAS = 32767, MAX_AREA = 268435456;
// Downscale factor (<= 1) that fits a w x h device-pixel image within those limits.
const fit = (w, h) => Math.min(1, MAX_CANVAS / w, MAX_CANVAS / h, Math.sqrt(MAX_AREA / (w * h)));
// Backstop for very large pages.
const MAX_FRAMES = 100;

// Tabs with a capture in progress: a second one would re-inject block() and interleave scrolling.
const busy = new Set();

chrome.runtime.onMessage.addListener(({ mode, tab }) => {
  if (busy.has(tab.id)) return;
  busy.add(tab.id);
  capture(tab, mode).finally(() => busy.delete(tab.id));
});

// mode: 'visible' | 'full' (stitched) | 'fast' (debugger). Opens the capture in a result tab (save, copy, print).
async function capture(tab, mode) {
  const full = mode !== 'visible';
  const badge = text => chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {}); // the tab may be gone
  const inPage = async (func, ...args) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;
  const name = fileName(tab);
  badge('...');
  let start = { x: 0, y: 0 };
  try {
    if (full) await inPage(block);
    // Page size at click time is the capture size, so infinite-scroll results loaded
    // while we scroll (eBay, feeds) are ignored instead of chased.
    // Visible area survives pages that block scripts as a plain screenshot (scrollbars included); a failed injection can also return null.
    start = (await inPage(full ? scrollThrough : here).catch(e => { if (full) throw e; })) ?? start;
    const { blob, note } = mode === 'fast' ? { blob: await debuggerShot(tab.id) }
      : full || start.w ? await stitch(tab, full, start, inPage)
      : { blob: await (await fetch(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))).blob() };
    const id = crypto.randomUUID();
    await idb('readwrite', st => st.put({ blob, name, note }, id));
    try {
      // Re-read the tab (it may have moved); create rejects an opener outside the target window, which defaults to the focused one.
      const t = await chrome.tabs.get(tab.id);
      await chrome.tabs.create({ url: 'result.html#' + id, windowId: t.windowId, index: t.index + 1, openerTabId: tab.id });
    } catch (e) {
      await idb('readwrite', st => st.delete(id)); // only result.js deletes it otherwise
      throw e;
    }
    badge('');
  } catch (e) {
    console.error(e);
    badge('ERR');
  } finally {
    await inPage(restore, start.x, start.y).catch(() => {});
  }
}

// Scroll the page viewport by viewport (left to right, then down), screenshot each, and stitch them;
// no viewport resizing, so the page lays out as displayed.
async function stitch(tab, full, start, inPage) {
  // captureVisibleTab grabs whatever tab is showing, so a tab switch would stitch in the wrong page.
  // A tab dragged to another window is still active there, so check the window too.
  const checkActive = async () => { const t = await chrome.tabs.get(tab.id); if (!t.active || t.windowId !== tab.windowId) throw new Error('Tab switched during capture'); };
  const x0 = full ? 0 : start.x, y0 = full ? 0 : start.y;
  const x1 = full ? start.w : x0 + 1, y1 = full ? start.h : y0 + 1;

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
      frames.push({ ...m, png: await (await fetch(shot)).blob() }); // decoded one at a time while drawing: 100 full-res bitmaps can run the worker out of memory
      more = true;
      // Overlap neighbours by 1px so each frame's (possibly blended) edge row is drawn over.
      x = m.x + m.vw - 1;
      nextY = m.y + m.vh - 1;
    }
    y = nextY;
  }

  // Stitch. Frame pixels per CSS px (devicePixelRatio x zoom); crop off both scrollbars.
  const first = await createImageBitmap(frames[0].png), s = first.width / frames[0].iw;
  first.close();
  const cssW = Math.min(start.w, Math.max(...frames.map(f => f.x + f.vw))) - x0;
  const cssH = Math.min(start.h, Math.max(...frames.map(f => f.y + f.vh))) - y0;
  const k = fit(cssW * s, cssH * s);
  const px = v => Math.round(v * s * k);
  const size = v => Math.floor(v * s * k + 1e-6); // floor: rounding both sides up can exceed MAX_AREA, which Chrome rejects
  const canvas = new OffscreenCanvas(size(cssW), size(cssH)), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Crop to whole device pixels: at fractional scaling (125%, 150%) a partial row would blend in the scrollbar.
  for (const f of frames) {
    const sw = Math.floor(f.vw * s), sh = Math.floor(f.vh * s);
    const img = await createImageBitmap(f.png);
    ctx.drawImage(img, 0, 0, sw, sh, px(f.x - x0), px(f.y - y0), Math.round(sw * k), Math.round(sh * k));
    img.close();
  }
  const cut = frames.length >= MAX_FRAMES && cssH < start.h - y0;
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), note: cut ? `Page too long: captured the first ${MAX_FRAMES} screens.` : undefined };
}

// One shot of the whole page via the DevTools protocol, like DevTools' "Capture full size screenshot".
// Fast and seamless, but Chrome resizes the viewport to the page: full-height sections stretch,
// and iframes outside the original viewport can come out blank.
async function debuggerShot(tabId) {
  const target = { tabId }, send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  await chrome.debugger.attach(target, '1.3');
  try {
    const { cssContentSize: { width, height } } = await send('Page.getLayoutMetrics');
    // Output is CSS size x devicePixelRatio x scale; keep it canvas-sized so result.js can re-encode it (JPG/PDF).
    const { result: { value: dpr } } = await send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
    const k = fit(width * dpr, height * dpr), scale = k < 1 ? k * 0.999 : 1; // margin: Chrome rounds the output size
    // Has hung once (eBay) and worked on retry; give up rather than leave the page locked.
    const { data } = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale } }),
      sleep(30000).then(() => { throw new Error('Fast capture timed out'); }),
    ]);
    return (await fetch('data:image/png;base64,' + data)).blob();
  } finally {
    await chrome.debugger.detach(target).catch(() => {}); // already detached (user cancelled the infobar): keep the shot or the real error
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// "261009104405 - www.ebay.com"
function fileName(tab) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map(p).join('');
  let host = '';
  try { host = new URL(tab.url).hostname; } catch {}
  return `${stamp} - ${host || tab.title || 'page'}`.replace(/[\\/:*?"<>|~\p{Cc}\p{Cf}]+/gu, '_').slice(0, 120).replace(/[. ]+$/, '');
}

// --- Injected into the page (must be self-contained) ---

// Swallow clicks, scrolling and keys so the user can't disturb a full-page capture.
// The shield is transparent, so it never shows in the frames.
function block() {
  window.justsaveUndo?.(); // a capture whose service worker died left its lock: undo it, or it outlives this one
  const shield = document.createElement('div');
  shield.id = 'justsave-shield';
  shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:wait;background:transparent';
  document.documentElement.append(shield);
  window.justsaveStop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  for (const t of ['wheel', 'keydown', 'touchmove']) addEventListener(t, window.justsaveStop, { capture: true, passive: false });
  window.justsaveUndo = () => {
    clearTimeout(window.justsaveDog);
    shield.remove();
    for (const t of ['wheel', 'keydown', 'touchmove']) removeEventListener(t, window.justsaveStop, { capture: true });
    for (const el of window.justsaveFrozen ?? []) {
      el.setAttribute('style', el.dataset.justsave);
      delete el.dataset.justsave;
    }
    window.justsaveFrozen = null;
  };
  // Watchdog: if the service worker dies mid-capture, restore() never comes, so unlock after 60s of silence
  // (longest gap: fast capture's 30s timeout plus encoding). Every injected step re-arms it.
  window.justsaveArm = () => { clearTimeout(window.justsaveDog); window.justsaveDog = setTimeout(window.justsaveUndo, 60000); };
  window.justsaveArm();
}

function here() {
  const d = document.scrollingElement || document.documentElement; // body in quirks mode
  return { x: scrollX, y: scrollY, w: d.scrollWidth, h: d.scrollHeight };
}

// Scroll through the page (as tall as it is now) so lazy-loaded content loads;
// returns the original scroll position and the page size.
async function scrollThrough() {
  const d = document.scrollingElement || document.documentElement, x = scrollX, y = scrollY, w = d.scrollWidth, h = d.scrollHeight, wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && scrollY + innerHeight < h; i++) {
    const before = scrollY;
    scrollBy({ top: innerHeight, behavior: 'instant' });
    if (scrollY === before) break; // at the bottom (fractional zoom can keep it a hair short of h) or the window can't scroll
    await wait(150);
  }
  return { x, y, w, h };
}

// vw/vh: the viewport without scrollbars (scrollingElement: body in quirks mode); iw: with them, to scale the frame.
function scrollToXY(x, y) {
  window.justsaveArm?.();
  scrollTo({ left: x, top: y, behavior: 'instant' });
  const d = document.scrollingElement || document.documentElement;
  return { x: scrollX, y: scrollY, vw: d.clientWidth, vh: d.clientHeight, iw: innerWidth };
}

// Sticky elements become relative (stay in their normal spot instead of repeating);
// after the first frame, fixed elements (headers, chat buttons) are hidden so they appear once.
function freeze(hideFixed) {
  window.justsaveArm?.();
  // Open shadow roots too: web components can carry their own sticky headers.
  const els = [], walk = root => { for (const el of root.querySelectorAll('*')) { els.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document.body ?? document.documentElement);
  for (const el of els) {
    const pos = getComputedStyle(el).position;
    if (pos !== 'sticky' && !(hideFixed && pos === 'fixed')) continue;
    if (!('justsave' in el.dataset)) el.dataset.justsave = el.getAttribute('style') ?? '';
    (window.justsaveFrozen ??= new Set()).add(el);
    if (pos === 'sticky') for (const [k, v] of [['position', 'relative'], ['top', 'auto'], ['right', 'auto'], ['bottom', 'auto'], ['left', 'auto']]) el.style.setProperty(k, v, 'important'); // insets would offset a relative box
    else el.style.setProperty('opacity', '0', 'important');
  }
}

function restore(x, y) {
  window.justsaveUndo?.();
  scrollTo({ left: x, top: y, behavior: 'instant' });
}
