// Run: node test.mjs
import assert from 'node:assert';
import { imagesToPdf, quietRow } from './extension/pdf.js';

// 6x4 red JPEG
const JPG = atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAYDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkKKKK8U/TD//Z');

const pdf = imagesToPdf([{ jpg: JPG, w: 6, h: 4 }, { jpg: JPG, w: 6, h: 4 }]);
assert.match(pdf, /\/Kids\[3 0 R 6 0 R\]\/Count 2/);
// Every xref offset must point at its object header.
const xref = +pdf.match(/startxref\n(\d+)/)[1];
const offsets = [...pdf.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map(m => +m[1]);
assert.strictEqual(offsets.length, 8);
offsets.forEach((o, i) => assert(pdf.startsWith(`${i + 1} 0 obj`, o), `obj ${i + 1} offset`));
if (process.argv[2]) (await import('node:fs')).writeFileSync(process.argv[2], pdf, 'latin1');

// quietRow: 10px wide, 5 rows; rows 0-1 white, row 2 has one dot, rows 3-4 striped -> lowest blank row is 1.
const W = 10, data = new Uint8Array(W * 5 * 4).fill(255);
data.fill(0, (2 * W + 5) * 4, (2 * W + 6) * 4);
for (let r = 3; r < 5; r++) for (let x = 0; x < W; x += 2) data.fill(0, (r * W + x) * 4, (r * W + x + 1) * 4);
assert.strictEqual(quietRow(data, W, 5), 1);
assert.strictEqual(quietRow(data.subarray(2 * W * 4), W, 3), 0); // no blank row -> least busy row
// Per-tab capture lock: a second capture on a busy tab must not inject block() again (it would leak listeners).
let onMsg, release;
console.error = () => {};
const injected = [];
globalThis.chrome = {
  runtime: { onMessage: { addListener: f => { onMsg = f; } } },
  action: { setBadgeText: async () => {} },
  scripting: { executeScript: async ({ func }) => {
    injected.push(func.name);
    if (func.name === 'block') await new Promise(r => { release = r; });
    if (func.name === 'scrollThrough') throw new Error('stop');
    return [{ result: { x: 0, y: 0, w: 1, h: 1 } }];
  } },
};
await import('./extension/background.js');
const tab = { id: 1, index: 0, url: 'https://x.test/' };
onMsg({ mode: 'full', tab });
onMsg({ mode: 'fast', tab });
await new Promise(r => setTimeout(r, 10));
release();
await new Promise(r => setTimeout(r, 10));
assert.deepStrictEqual(injected.filter(n => n === 'block'), ['block']);
onMsg({ mode: 'visible', tab }); // lock released after the first capture finished
await new Promise(r => setTimeout(r, 10));
assert.strictEqual(injected.filter(n => n === 'here').length, 1);
// freeze(): a sticky element turned relative must also drop its insets, or top:80px shifts it for good.
// It walks all of <html>: widgets appended next to <body> must be frozen too (the fake body is empty).
const src = (await import('node:fs')).readFileSync('./extension/background.js', 'utf8').match(/function freeze[\s\S]*?\r?\n}\r?\n/)[0];
const set = {}, el = { dataset: {}, getAttribute: () => null, style: { setProperty: (k, v) => { set[k] = v; } } };
const shadowEl = { dataset: {}, getAttribute: () => null, style: { setProperty() { shadowEl.frozen = true; } } };
const host = { shadowRoot: { querySelectorAll: () => [shadowEl] } }, win = {};
new Function('window', 'document', 'getComputedStyle', src + 'freeze(false);')(win, { body: { querySelectorAll: () => [] }, documentElement: { querySelectorAll: () => [el, host] } }, e => ({ position: e === host ? 'static' : 'sticky' }));
assert(shadowEl.frozen && win.justsaveFrozen.has(shadowEl), 'freeze() skipped a shadow root');
assert.strictEqual(set.position, 'relative');
for (const k of ['top', 'right', 'bottom', 'left']) assert.strictEqual(set[k], 'auto', k);
// Stitch canvas: when the area limit binds, independently rounding each side up must not exceed it (Chrome rejects the canvas).
const dims = [];
globalThis.OffscreenCanvas = class { constructor(w, h) { dims.push([w, h]); } getContext() { return { fillRect() {}, drawImage() {} }; } convertToBlob() { return {}; } };
globalThis.createImageBitmap = async () => ({ width: 8297, close() {} }); // 5531 CSS px at 150%
globalThis.fetch = async () => ({ blob: async () => ({}) });
chrome.tabs = { get: async () => ({ active: true }), captureVisibleTab: async () => '', create() {} };
chrome.scripting.executeScript = async ({ func }) => [{ result: func.name === 'scrollToXY' ? { x: 0, y: 0, vw: 5531, vh: 21715, iw: 5531 } : { x: 0, y: 0, w: 5531, h: 21715 } }];
onMsg({ mode: 'visible', tab: { id: 2, index: 0, url: 'https://x.test/' } });
await new Promise(r => setTimeout(r, 600)); // waits out the shared captureVisibleTab pacing
assert.strictEqual(dims.length, 1);
assert(dims[0][0] * dims[0][1] <= 268435456, 'stitch canvas ' + dims[0]);
// Full page: frames are decoded one at a time while drawing, not all held as bitmaps (100 4K frames run the worker out of memory).
{
  let live = 0, peak = 0;
  const cib = globalThis.createImageBitmap, ex = chrome.scripting.executeScript;
  globalThis.createImageBitmap = async () => { peak = Math.max(peak, ++live); return { width: 100, close() { live--; } }; };
  chrome.scripting.executeScript = async ({ func, args }) => [{ result: func.name === 'scrollToXY' ? { x: 0, y: Math.min(args[1], 50), vw: 100, vh: 100, iw: 100 } : { x: 0, y: 0, w: 100, h: 150 } }];
  onMsg({ mode: 'full', tab: { id: 6, index: 0, url: 'https://x.test/' } });
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(dims.length, 2);
  assert.strictEqual(peak, 1, 'frames held as decoded bitmaps');
  globalThis.createImageBitmap = cib; chrome.scripting.executeScript = ex;
}
// Fast capture: output is CSS size x devicePixelRatio x clip.scale, and must fit the canvas limits too (result.js re-encodes it).
let clip;
const fastLog = [], ex0 = chrome.scripting.executeScript;
chrome.scripting.executeScript = async o => { fastLog.push([o.func.name, ...(o.args ?? [])].join()); return ex0(o); };
chrome.debugger = { attach: async () => {}, detach: async () => {}, sendCommand: async (t, m, p) =>
  m === 'Page.getLayoutMetrics' ? { cssContentSize: { width: 1200, height: 20000 } }
  : m === 'Runtime.evaluate' ? { result: { value: 2 } }
  : (clip = p.clip, fastLog.push('shot'), { data: '' }) };
onMsg({ mode: 'fast', tab: { id: 3, index: 0, url: 'https://x.test/' } });
await new Promise(r => setTimeout(r, 700));
chrome.scripting.executeScript = ex0;
// ...taken from the top, not where scrollThrough left the page (hide-on-scroll headers would show scrolled-down).
assert(fastLog.indexOf('scrollToXY,0,0') > fastLog.indexOf('scrollThrough') && fastLog.indexOf('scrollToXY,0,0') < fastLog.indexOf('shot'), 'fast shot taken scrolled down: ' + fastLog);
const out = [clip.width * 2 * clip.scale, clip.height * 2 * clip.scale];
assert(out[0] <= 32767 && out[1] <= 32767 && out[0] * out[1] <= 268435456, 'fast capture ' + out);
// Result tab handoff: open it in the source tab's current window (create rejects an opener in another window),
// and if it still can't open, drop the stored capture instead of orphaning it in IndexedDB.
const files = new Map();
globalThis.indexedDB = { open() { const o = {}; setTimeout(() => { o.result = { close() {}, transaction() {
  const tx = { objectStore: () => ({ put: (v, k) => (files.set(k, v), {}), delete: k => (files.delete(k), {}), openCursor() {
    const req = {}, keys = [...files.keys()];
    const step = () => setTimeout(() => { const k = keys.shift(); req.onsuccess?.({ target: { result: k === undefined ? null : { value: files.get(k), delete: () => files.delete(k), continue: step } } }); });
    step(); return req;
  } }) };
  setTimeout(() => tx.oncomplete());
  return tx;
} }; o.onsuccess(); }); return o; } };
const created = [];
chrome.tabs.get = async () => ({ active: true, windowId: 7, index: 4 });
chrome.tabs.create = async p => { if (p.windowId !== 7) throw new Error('opener in another window'); created.push(p); return { id: 99 }; };
const updated = [];
files.set('stale', { blob: {} }); // left by a result tab that never loaded (closed, crash, worker died)
chrome.tabs.update = async (id, p) => { updated.push([id, p]); };
onMsg({ mode: 'visible', tab: { id: 4, index: 0, windowId: 7, url: 'https://x.test/' } }); // create defaults to the focused window, not 7
await new Promise(r => setTimeout(r, 600));
assert.strictEqual(created.length, 1);
assert.strictEqual(created[0].index, 5);
assert.strictEqual(files.size, 1);
assert(!files.has('stale'), 'stale capture never swept from IndexedDB');
// Memory Saver must not discard the result tab: result.js already deleted the record, so a reload loses the capture.
assert.deepStrictEqual(updated, [[99, { autoDiscardable: false }]], 'result tab is discardable');
files.clear();
chrome.tabs.create = async () => { throw new Error('window closed'); };
onMsg({ mode: 'visible', tab: { id: 5, index: 0, windowId: 7, url: 'https://x.test/' } });
await new Promise(r => setTimeout(r, 600));
assert.strictEqual(files.size, 0, 'orphaned capture');
// captureVisibleTab's 2 calls/s quota is per extension: concurrent captures in two tabs must share the pacing.
{
  const at = [], cvt = chrome.tabs.captureVisibleTab, ex = chrome.scripting.executeScript;
  chrome.tabs.create = async () => ({ id: 98 });
  chrome.tabs.get = async id => ({ active: true, windowId: id === 11 ? 8 : 7, index: 0 });
  chrome.tabs.captureVisibleTab = async () => { at.push(performance.now()); return ''; };
  chrome.scripting.executeScript = async ({ func, args }) => [{ result: func.name === 'scrollToXY' ? { x: 0, y: Math.min(args[1], 50), vw: 100, vh: 100, iw: 100 } : { x: 0, y: 0, w: 100, h: 150 } }];
  onMsg({ mode: 'full', tab: { id: 10, index: 0, windowId: 7, url: 'https://x.test/' } });
  onMsg({ mode: 'full', tab: { id: 11, index: 0, windowId: 8, url: 'https://x.test/' } });
  await new Promise(r => setTimeout(r, 2500));
  assert.strictEqual(at.length, 4);
  at.sort((a, b) => a - b).slice(1).forEach((t, i) => assert(t - at[i] >= 500, 'captureVisibleTab calls ' + (t - at[i]).toFixed(1) + 'ms apart'));
  chrome.tabs.captureVisibleTab = cvt; chrome.scripting.executeScript = ex;
}
// The debugger's infobar resizes every window's viewport: a fast shot in one window must not land mid-stitch in another.
{
  const log = [], cvt = chrome.tabs.captureVisibleTab, ex = chrome.scripting.executeScript, dbg = chrome.debugger;
  chrome.tabs.get = async id => ({ active: true, windowId: id === 21 ? 8 : 7, index: 0 });
  chrome.tabs.captureVisibleTab = async () => { log.push('frame'); return ''; };
  chrome.debugger = { ...dbg, attach: async () => { log.push('attach'); }, detach: async () => { log.push('detach'); } };
  chrome.scripting.executeScript = async ({ func, args }) => [{ result: func.name === 'scrollToXY' ? { x: 0, y: Math.min(args[1], 50), vw: 100, vh: 100, iw: 100 } : { x: 0, y: 0, w: 100, h: 150 } }];
  onMsg({ mode: 'full', tab: { id: 20, index: 0, windowId: 7, url: 'https://x.test/' } });
  onMsg({ mode: 'fast', tab: { id: 21, index: 0, windowId: 8, url: 'https://x.test/' } });
  await new Promise(r => setTimeout(r, 2500));
  assert.deepStrictEqual(log, ['frame', 'frame', 'attach', 'detach'], 'fast shot during a stitched capture: ' + log);
  chrome.tabs.captureVisibleTab = cvt; chrome.scripting.executeScript = ex; chrome.debugger = dbg;
}
// Watchdog: if the service worker dies mid-capture (restore() never comes), block() must unlock the page by itself.
const bg = (await import('node:fs')).readFileSync('./extension/background.js', 'utf8'), fn = n => bg.match(new RegExp(String.raw`function ${n}\([\s\S]*?\r?\n}\r?\n`))[0];
// stitch(): hitting MAX_FRAMES partway through the bottom row leaves its right part white, which needs the truncation note too.
{
  const page = { w: 297, h: 3367 }; // 3 columns x 34 rows: frame 100 is the bottom row's first column
  const run = new Function('chrome', 'MAX_FRAMES', 'fit', 'sleep', 'shotSlot', 'freeze', 'scrollToXY', 'createImageBitmap', 'OffscreenCanvas', 'fetch', 'async ' + fn('stitch') + 'return stitch;')(
    { tabs: { get: async () => ({ active: true, windowId: 1 }), captureVisibleTab: async () => '' } }, 100, () => 1, async () => {}, async () => {}, 'freeze', 'scrollToXY',
    async () => ({ width: 100, close() {} }), class { getContext() { return { fillRect() {}, drawImage() {} }; } convertToBlob() { return {}; } }, async () => ({ blob: async () => ({}) }));
  const inPage = async (f, x, y) => f === 'scrollToXY' ? { x: Math.min(x, page.w - 100), y: Math.min(y, page.h - 100), vw: 100, vh: 100, iw: 100 } : undefined;
  const { note } = await run({ windowId: 1 }, true, page, inPage);
  assert(note, 'partial last row cut without a note');
}
// stitch(): a minimized or fully covered window stops painting, so captureVisibleTab returns a stale frame; refuse it.
{
  let shots = 0;
  const run = new Function('chrome', 'MAX_FRAMES', 'fit', 'sleep', 'shotSlot', 'freeze', 'scrollToXY', 'createImageBitmap', 'OffscreenCanvas', 'fetch', 'async ' + fn('stitch') + 'return stitch;')(
    { tabs: { get: async () => ({ active: true, windowId: 1 }), captureVisibleTab: async () => { shots++; return ''; } } }, 100, () => 1, async () => {}, async () => {}, 'freeze', 'scrollToXY',
    async () => ({ width: 100, close() {} }), class { getContext() { return { fillRect() {}, drawImage() {} }; } convertToBlob() { return {}; } }, async () => ({ blob: async () => ({}) }));
  const inPage = async (f, x, y) => f === 'scrollToXY' ? { x, y: Math.min(y, 100), vw: 100, vh: 100, iw: 100 } : typeof f === 'function' ? 'hidden' : undefined;
  await assert.rejects(run({ windowId: 1 }, true, { w: 100, h: 200 }, inPage), /hidden|minimized|visible/i, 'stitched frames from a hidden window');
  assert.strictEqual(shots, 0, 'captured a hidden window');
}
let timer, shield = { style: {}, remove() { shield.gone = true; } };
const listeners = new Set(), page = { dataset: { justsave: 'color:red' }, setAttribute(k, v) { page.restored = v; } };
const doc = { createElement: () => shield, documentElement: { append() {} } };
new Function('window', 'document', 'addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', 'scrollTo', fn('block') + 'block();')(
  { justsaveFrozen: new Set([page]) }, doc, (t, f) => listeners.add(t), t => listeners.delete(t), f => (timer = f), () => { timer = null; }, () => {});
assert(timer, 'block() arms no watchdog');
timer();
assert(shield.gone && listeners.size === 0 && page.restored === 'color:red', 'watchdog left the page locked');
// block() again after a service worker restart (busy flag lost): the earlier lock must not survive one undo.
{
  const win = {}, shields = [], live = [];
  const run = () => new Function('window', 'document', 'addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', fn('block') + 'block();')(
    win, { createElement: () => { const s = { style: {}, remove() { s.gone = true; } }; shields.push(s); return s; }, documentElement: { append() {} } },
    (t, f) => live.push([t, f]), (t, f) => live.splice(live.findIndex(l => l[0] === t && l[1] === f) >>> 0, 1), () => 1, () => {});
  run(); run();
  win.justsaveUndo();
  assert(shields.every(s => s.gone) && live.length === 0, 'second block() left the first lock in place');
}
// block(): root scroll snapping would move each programmatic scroll to a snap point (skipped bands, early stop); it must be off while locked, and back on undo.
{
  const win = {}, made = [], root = [];
  new Function('window', 'document', 'addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', fn('block') + 'block();')(
    win, { createElement: t => { const s = { tag: t, style: {}, remove() { root.splice(root.indexOf(s) >>> 0, 1); } }; made.push(s); return s; }, documentElement: { append: (...a) => root.push(...a) } },
    () => {}, () => {}, () => 1, () => {});
  assert(root.some(s => s.tag === 'style' && /html\s*,\s*body\s*\{\s*scroll-snap-type:\s*none\s*!important/.test(s.textContent)), 'scroll snapping left on during capture');
  win.justsaveUndo();
  assert.strictEqual(root.length, 0, 'undo left the snap override in place');
}
// block(): middle-click autoscroll starts on mousedown, and a focused iframe's keys never reach the top window; both scroll mid-capture.
{
  const live = [], frame = { tagName: 'IFRAME', blur() { frame.blurred = true; } };
  new Function('window', 'document', 'addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', fn('block') + 'block();')(
    {}, { activeElement: frame, createElement: () => ({ style: {} }), documentElement: { append() {} } }, t => live.push(t), () => {}, () => 1, () => {});
  assert(live.includes('mousedown'), 'middle-click autoscroll not blocked');
  assert(frame.blurred, 'focused iframe keeps keyboard scrolling');
}
// fileName: file names reject control and format characters (ZWJ, RLM) that titles of host-less pages can carry.
const fileName = new Function(fn('fileName') + 'return fileName;')();
assert.doesNotMatch(fileName({ url: 'file:///x', title: 'a‍b‏cd' }), /[‍‏]/u);
// ...and the 120-unit cut must not split an emoji's surrogate pair.
assert(fileName({ url: 'file:///x', title: 'a'.repeat(104) + '😀' }).isWellFormed(), 'lone surrogate in file name');
// scrollThrough: stop when the page no longer scrolls (fractional zoom, unscrollable window) instead of looping 100x150ms.
const t0 = Date.now();
await new Function('window', 'document', 'scrollX', 'scrollY', 'innerHeight', 'scrollBy', 'setTimeout', 'async ' + fn('scrollThrough') + 'return scrollThrough();')(
  {}, { documentElement: { scrollWidth: 800, scrollHeight: 5000 } }, 0, 0, 600, () => {}, setTimeout);
assert(Date.now() - t0 < 1000, 'scrollThrough kept waiting on a page that does not scroll');
// scrollThrough: re-arms the watchdog each step, so a long scroll-through plus a 30s fast capture can't let it unlock the page mid-capture.
{
  let arms = 0;
  const env = { window: { justsaveArm: () => arms++ }, document: { documentElement: { scrollWidth: 800, scrollHeight: 3000 } }, scrollX: 0, scrollY: 0, innerHeight: 600,
    scrollBy: ({ top }) => { env.scrollY += top; }, setTimeout: f => f() };
  await new Function('env', 'with (env) { async ' + fn('scrollThrough') + 'return scrollThrough(); }')(env);
  assert(arms >= 4, 'scrollThrough re-armed the watchdog ' + arms + 'x over 4 steps');
}
// scrollThrough: fast mode (no step cap) shoots the whole page, so it must scroll past 100 screens to trigger lazy content.
{
  const env = { window: {}, document: { documentElement: { scrollWidth: 800, scrollHeight: 600 * 150 } }, scrollX: 0, scrollY: 0, innerHeight: 600,
    scrollBy: ({ top }) => { env.scrollY += top; }, setTimeout: f => f() };
  await new Function('env', 'with (env) { async ' + fn('scrollThrough') + 'return scrollThrough(); }')(env);
  assert(env.scrollY + 600 >= 600 * 150, 'fast scroll-through stopped at ' + env.scrollY);
}
// Markup geometry and serialization.
const { dragEdges, bounds, move, resize, toSvg, snap, nextSize } = await import('./extension/markup.js');
assert.deepStrictEqual(snap([0, 0], [10, 2]).map(Math.round), [10, 0]); // near-horizontal -> horizontal
assert.deepStrictEqual(snap([0, 0], [-1, -10]).map(Math.round), [0, -10]); // near-vertical -> vertical
assert.deepStrictEqual(snap([0, 0], [9, 11]).map(v => Math.round(v * 10)), [100, 100]); // diagonal, same length
assert.deepStrictEqual([nextSize(20, 1), nextSize(20, -1), nextSize(21, -1), nextSize(96, 1), nextSize(8, -1)], [24, 18, 20, 96, 8]);
assert.deepStrictEqual(dragEdges({ l: 10, t: 10, r: 20, b: 20 }, 'e', -15, 0), { l: 5, t: 10, r: 10, b: 20 }); // past the far edge flips
assert.deepStrictEqual(dragEdges({ l: 10, t: 10, r: 20, b: 20 }, 'nw', -50, 5, { l: 0, t: 0, r: 30, b: 30 }), { l: 0, t: 15, r: 20, b: 20 });
assert.deepStrictEqual(resize({ type: 'pen', pts: [[0, 0], [5, 5], [10, 10]] }, 'se', 10, 0).pts, [[0, 0], [10, 5], [20, 10]]);
assert.deepStrictEqual(resize({ type: 'hl', pts: [[0, 4], [10, 4]] }, 's', 0, 6).pts, [[0, 4], [10, 4]]); // a flat line doesn't divide by 0
assert.deepStrictEqual(resize({ type: 'line', pts: [[0, 0], [10, 10]] }, '1', 5, -5).pts, [[0, 0], [15, 5]]);
const label = { type: 'text', size: 10, em: 2, x: 10, y: 10, text: 'ab' }; // 20 x 12.5
assert.deepStrictEqual(bounds(resize(label, 'se', 0, 12.5)), { l: 10, t: 10, r: 50, b: 35 }); // double size, top-left stays
assert.deepStrictEqual(bounds(resize(label, 'nw', 0, -12.5)), { l: -10, t: -2.5, r: 30, b: 22.5 }); // bottom-right stays
assert.deepStrictEqual(bounds(resize(label, 'se', 20, 0)), { l: 10, t: 10, r: 50, b: 35 }); // a horizontal drag scales too
assert.deepStrictEqual(bounds(resize(label, 'se', -30, 0)), { l: 0, t: 10, r: 10, b: 16.25 }); // dragged past the left edge: half size, hanging left of the anchor
assert.ok(Number.isFinite(resize({ ...label, em: 0, text: "u200b" }, "se", 30, 0).size)); // zero-width text: no divide by 0
const call = move({ type: 'callout', size: 10, em: 1, x: 0, y: 0, text: 'a', tip: [50, 50], w: 2 }, 3, 4);
assert.deepStrictEqual([call.x, call.y, call.tip], [3, 4, [53, 54]]);
assert.deepStrictEqual(resize(call, 'tip', 1, 1).tip, [54, 55]);
const svg = toSvg([{ type: 'text', c: 'red', size: 10, em: 1, x: 0, y: 0, text: '<a>\n&b' }, { type: 'cloud', c: 'red', w: 2, l: 0, t: 0, r: 100, b: 50 }], { x: 5, y: 6, w: 100, h: 50 });
assert.match(svg, /viewBox="5 6 100 50" width="100" height="50"/); // the crop offset shifts the view, not the shapes
assert.match(svg, /&#60;a&#62;<\/tspan><tspan[^>]*>&#38;b</);
assert.strictEqual(svg.match(/A\d/g).length, 8 + 4 + 8 + 4); // 12-px scallops: 100 / 12 ≈ 8 per long side, 50 / 12 ≈ 4 per short
assert.doesNotMatch(svg, /opacity="0"/); // hit outlines only on screen
// Constants scale with dpr like the widths do: 2x the width at dpr 2 draws 2x the arrowhead and scallops.
assert.match(toSvg([{ type: 'arrow', c: 'red', w: 4, pts: [[0, 0], [1000, 0]] }], { x: 0, y: 0, w: 9, h: 9 }, 0, 2), /M1000 0L964 18L964 -18Z/); // head 3 * 4 + 12 * 2 = 36 long
assert.strictEqual(toSvg([{ type: 'cloud', c: 'red', w: 1, l: 0, t: 0, r: 100, b: 50 }], { x: 0, y: 0, w: 100, h: 50 }, 0, 2).match(/A\d/g).length, 4 + 2 + 4 + 2); // 24-px scallops
// A shape keeps the dpr it was drawn at, so later zoom changes don't change its export (bughunt L3 export-r1-3).
assert.match(toSvg([{ type: 'arrow', c: 'red', w: 4, dpr: 1, pts: [[0, 0], [1000, 0]] }], { x: 0, y: 0, w: 9, h: 9 }, 0, 2), /M1000 0L976 12L976 -12Z/);
assert.strictEqual(toSvg([{ type: 'cloud', c: 'red', w: 1, dpr: 1, l: 0, t: 0, r: 100, b: 50 }], { x: 0, y: 0, w: 100, h: 50 }, 0, 2).match(/A\d/g).length, 8 + 4 + 8 + 4);
const odd = toSvg([{ type: 'text', c: 'red', size: 10, em: 1, x: 0, y: 0, text: 'a\f\v\u0000\u001b￾￿\ud800b\tc' }], { x: 0, y: 0, w: 9, h: 9 });
assert.doesNotMatch(odd, /[^\n\r -퟿-�\u{10000}-\u{10ffff}]/u); // only XML-legal characters, or the export can't decode it
assert.match(odd, />ab c</); // a tab draws as the one space it's measured as
assert.match(toSvg([{ type: 'ellipse', c: '#000', w: 2, fill: true, l: 0, t: 0, r: 9, b: 9 }], { x: 0, y: 0, w: 9, h: 9 }), /fill="#000"/);
assert.strictEqual(toSvg([{ type: 'rect', c: 'red', w: 2, l: 0, t: 0, r: 9, b: 9 }], { x: 0, y: 0, w: 9, h: 9 }, 8).match(/stroke-width="10"/g).length, 1);
for (const [l, r] of [[0, 3], [0, 100], [0.04, 7.26]]) { // each arc must span the full box width, so rx is half the endpoint distance
  const [, x0, , rx, , x1] = toSvg([{ type: 'ellipse', c: 'red', w: 2, l, t: 0, r, b: 300 }], { x: 0, y: 0, w: 9, h: 9 }).match(/d="M([\d.]+) ([\d.]+)A([\d.]+) ([\d.]+) 0 1 0 ([\d.]+)/);
  assert.ok(Math.abs(+rx * 2 - (+x1 - +x0)) < 1e-9, `ellipse ${l}..${r}: rx ${rx} vs ${x0}..${x1}`);
}
// Text edit: a window blur (Alt+Tab) leaves the textarea focused, so it must not end the edit; a real blur does.
const onblur = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8').match(/edit\.onblur = .*/)[0];
for (const [active, ends] of [['edit', false], ['body', true]]) {
  let ended = false;
  const edit = {};
  new Function('edit', 'document', 'finishEdit', onblur)(edit, { activeElement: active === 'edit' ? edit : {} }, () => { ended = true; });
  edit.onblur();
  assert.strictEqual(ended, ends, `blur with ${active} focused`);
}
// Fill with a line selected toggles the default fill both ways (a line has no fill of its own).
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const style = { pen: { fill: false }, hl: {} }, shapes = [{ type: 'line', pts: [] }];
  const tools = {};
  new Function('$', 'shapes', 'style', 'styleOf', 'commit', 'render', `let gesture = false, cur = 0, editing = null, tool = 'select', dpr = 1; ${src.match(/const filled = .*/)?.[0]}; ${src.match(/\$\('tools'\)\.onclick = [\s\S]*?\n};/)[0]}`)(
    () => tools, shapes, style, () => style.pen, () => {}, () => {});
  const click = () => tools.onclick({ target: { closest: () => ({ dataset: { fill: '' } }) } });
  click();
  assert.strictEqual(style.pen.fill, true);
  click();
  assert.strictEqual(style.pen.fill, false, 'second Fill click turns the default fill off');
}
// Delete/Backspace on the Format or Quality <select> must not delete the selected shape.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  let removed = 0;
  const f = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => true, () => { removed++; }, {}, () => {}, () => {}, { dataset: {} });
  f({ key: 'Delete', target: { tagName: 'SELECT' } });
  f({ key: 'Backspace', target: { tagName: 'SELECT' } });
  assert.strictEqual(removed, 0, 'Delete on a <select> removed the shape');
  f({ key: 'Delete', target: { tagName: 'BODY' } });
  assert.strictEqual(removed, 1);
  // Ctrl+P on a non-Latin layout (e.key 'з', e.code 'KeyP') must still be intercepted.
  const ran = [];
  const g = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    a => ran.push(a), () => {}, () => false, () => true, () => {}, {}, () => {}, () => {}, { dataset: {} });
  let prevented = 0;
  g({ ctrlKey: true, key: 'з', code: 'KeyP', target: { tagName: 'BODY' }, preventDefault: () => prevented++ });
  assert.ok(prevented === 1 && ran[0] === 'print', 'Ctrl+P on a non-Latin layout was not intercepted');
  g({ ctrlKey: true, key: 'l', code: 'KeyP', target: { tagName: 'BODY' }, preventDefault: () => prevented++ }); // Dvorak Ctrl+L
  assert.ok(prevented === 1 && ran.length === 1, 'Ctrl+L on Dvorak was taken for print');
  const steps = [];
  const h = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => false, () => {}, {}, d => steps.push(d), () => {}, { dataset: {} });
  h({ metaKey: true, key: 'z', target: { tagName: 'BODY' }, preventDefault: () => {} });
  h({ metaKey: true, shiftKey: true, key: 'z', target: { tagName: 'BODY' }, preventDefault: () => {} });
  assert.deepStrictEqual(steps, [-1, 1], 'Cmd+Z / Cmd+Shift+Z did not undo / redo');
  // Esc during IME composition belongs to the IME; it must not end the edit.
  let fin = 0;
  const edit = {};
  const m = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => fin++, () => false, () => true, () => {}, edit, () => {}, () => {}, { dataset: {} });
  m({ key: 'Escape', isComposing: true, target: edit });
  assert.strictEqual(fin, 0, 'Esc during IME composition ended the edit');
  m({ key: 'Escape', target: edit });
  assert.strictEqual(fin, 1);
}
// Fit in a window shorter than the header must not go to a zero or negative scale.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const shot = { naturalWidth: 800, naturalHeight: 600, style: {} }, label = {};
  const [apply, get] = new Function('$', 'shot', 'header', 'document', 'innerHeight', 'devicePixelRatio', 'render', `let zoom = 'fit', scale = 1; ${src.match(/function applyZoom\(\) \{[\s\S]*?\n\}/)[0]} return [applyZoom, () => scale];`)(
    () => label, shot, { offsetHeight: 90 }, { documentElement: { clientWidth: 1000 } }, 100, 1, () => {});
  apply();
  assert.ok(get() > 0, `fit scale ${get()} in a short window`);
  // Fit with a vertical scrollbar that goes away once the capture shrinks: size for the width without it.
  const wide = { naturalWidth: 2000, naturalHeight: 400, style: {} };
  const doc = { documentElement: { get clientWidth() { return parseFloat(wide.style.width) > 1500 ? 983 : 1000; } } };
  wide.style.width = '3000px'; // zoomed in: tall page with a scrollbar
  const [apply2, get2] = new Function('$', 'shot', 'header', 'document', 'innerHeight', 'devicePixelRatio', 'render', `let zoom = 'fit', scale = 1; ${src.match(/function applyZoom\(\) \{[\s\S]*?\n\}/)[0]} return [applyZoom, () => scale];`)(
    () => label, wide, { offsetHeight: 90 }, doc, 900, 1, () => {});
  apply2();
  assert.equal(get2(), (1000 - 32) / 2000, 'Fit kept the width of a scrollbar that went away');
  // A header that changes height (status text, Quality select) re-runs the Fit math, not only the page padding.
  let ro, zoomed = 0;
  new Function('ResizeObserver', 'document', 'header', 'applyZoom', src.match(/new ResizeObserver\(.*/)[0])(
    class { constructor(f) { ro = f; } observe() {} }, { body: { style: {} } }, { offsetHeight: 120 }, () => zoomed++);
  ro();
  assert.equal(zoomed, 1, 'header resize did not re-run applyZoom');
}
// Zooming the browser keeps the picked width and text size in screen pixels, and the pressed-state match exact.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const style = { pen: { w: 4, size: 20 }, hl: { w: 8 } }, g = { devicePixelRatio: 1 };
  const [sync, get] = new Function('style', 'g', `let dpr = 1; ${src.match(/function syncDpr\(\) \{[\s\S]*?\n\}/)[0].replaceAll('devicePixelRatio', 'g.devicePixelRatio')} return [syncDpr, () => dpr];`)(style, g);
  for (const r of [1.1, 1.25, 2.5, 0.9, 1]) {
    g.devicePixelRatio = r;
    sync();
    assert.equal(get(), r);
    assert.ok(style.pen.w === 4 * r && style.pen.size === 20 * r && style.hl.w === 8 * r, `at ${r}: ${JSON.stringify(style)}`);
  }
}
// Crop swap: from Apply crop until the new image has loaded, a gesture would mix the old image's geometry with the new offset.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8'), m = re => src.match(re)[0];
  let release, downs = 0;
  const stage = { classList: { contains: c => c === 'marking', remove() {} }, setPointerCapture() {} }, shot = {}, el = { style: {} };
  const t = new Function('$', 'stage', 'shot', 'sel', 'edit', 'document', 'URL', 'OffscreenCanvas', 'createImageBitmap', 'cropping', 'marking', 'cropDown', 'markDown', 'applyZoom',
    `let gesture = false, editing = null, swapping = false, png = 'old', off = { x: 0, y: 0 }, original, box = { l: 2, t: 2, r: 6, b: 6 };
    ${m(/function setShot\([\s\S]*?\n\}/)} ${m(/function endCrop\([\s\S]*?\n\}/)} ${m(/async function applyCrop\([\s\S]*?\n\}/)}
    ${m(/stage\.onpointerdown = [\s\S]*?\n\};/)} ${m(/stage\.onpointercancel = [\s\S]*?\n\};/)} ${m(/shot\.onload = .*/)} return applyCrop;`)(
    () => el, stage, shot, el, {}, { activeElement: { blur() {} } }, { createObjectURL: () => 'blob:new', revokeObjectURL() {} },
    class { getContext() { return { drawImage() {} }; } convertToBlob() { return 'new'; } }, () => new Promise(r => { release = r; }),
    () => false, () => true, () => downs++, () => downs++, () => {});
  const down = () => stage.onpointerdown({ button: 0, pointerId: 1, target: {}, preventDefault() {} }) || stage.onlostpointercapture({});
  const applying = t();
  down();
  release({});
  await applying;
  down();
  assert.strictEqual(downs, 0, 'gesture started while the cropped image was swapping in');
  shot.onload();
  down();
  assert.strictEqual(downs, 1);
}
// Toolbar presses while a new text is open: the editor keeps focus (so blur can't delete the empty text first), a swatch styles the pending text, Undo only cancels it.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const style = { pen: { c: 'red', size: 20 }, text: { c: 'red' } }, shapes = [{ type: 'text', c: 'red', size: 20, text: '' }], tools = {}, log = [];
  new Function('$', 'shapes', 'style', 'styleOf', 'commit', 'render', 'finishEdit', 'go', 'edit', 'log', `let gesture = false, cur = 0, editing = 0, tool = 'text', dpr = 1; const stage = { dataset: {} };
    ${src.match(/const filled = .*/)?.[0]}; ${src.match(/\$\('tools'\)\.onmousedown = .*/)?.[0]}; ${src.match(/\$\('tools'\)\.onclick = [\s\S]*?\n};/)[0]}`)(
    () => tools, shapes, style, () => style.text, () => log.push('commit'), () => {}, () => log.push('finish'), () => log.push('go'), { value: '' }, log);
  let prevented = 0;
  tools.onmousedown({ preventDefault: () => prevented++ });
  assert.strictEqual(prevented, 1, 'toolbar press moved focus out of the editor');
  tools.onclick({ target: { closest: () => ({ dataset: { c: 'blue' } }) } });
  assert.strictEqual(shapes[0].c, 'blue', 'swatch did not style the pending text');
  assert.ok(!log.includes('commit'), 'swatch committed an empty text');
  log.length = 0;
  tools.onclick({ target: { closest: () => ({ dataset: { cmd: 'undo' } }) } });
  assert.ok(!log.includes('go'), 'Undo on an empty new text also undid the previous commit');
}
// Capture note ('Page too long…'): shown in its own element, which Save/Copy/Print/Crop status messages never overwrite.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const els = {}, $ = id => (els[id] ??= { textContent: '' });
  new Function('$', 'document', 'URL', 'png', 'note', 'name', src.match(/if \(png\) \{[\s\S]*?\n\}/)[0])($, {}, { createObjectURL: () => '' }, {}, 'Page too long', 'x');
  const at = Object.keys(els).find(k => els[k].textContent === 'Page too long');
  assert.notStrictEqual(at, 'status', 'note shown in the transient status line');
  assert.strictEqual(src.split(`$('${at}').textContent`).length, 2, 'something else overwrites the note');
}
// Print: if print() returns without firing afterprint (policy-blocked, throttled), .burned must not linger for menu Print.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const cls = new Set(), p = { decode: async () => {}, removeAttribute() {} };
  const act = new Function('$', 'encode', 'document', 'URL', 'addEventListener', 'print',
    `return {${src.match(/async print\(\) \{[\s\S]*?\n  \},/)[0]}}`)(
    () => p, async () => ({}), { body: { classList: { add: c => cls.add(c), remove: c => cls.delete(c) } } },
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, () => {}, () => {});
  await act.print();
  assert.ok(!cls.has('burned'), 'body.burned left set after a print() that never fired afterprint');
}
// Save: an AbortError from close() (Safe Browsing / DLP block after write) is a failure, not a cancelled picker.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const abort = () => Object.assign(new Error('Write operation blocked by Safe Browsing.'), { name: 'AbortError' });
  const els = {}, $ = id => (els[id] ??= { value: 'png', textContent: '' });
  let picker;
  const run = new Function('$', 'encode', 'showSaveFilePicker', 'TYPES', 'name', 'png',
    `const ACTIONS = {${src.match(/async save\(fmt\) \{[\s\S]*?\n  \},/)[0]}}; ${src.match(/let busy = false;[\s\S]*?\n\}/)[0]}; return run;`)(
    $, async () => ({}), async () => picker(), { png: { description: 'PNG', mime: 'image/png' } }, 'x', {});
  picker = async () => ({ name: 'x.png', getFile: async () => ({ size: 0 }), remove: async () => {},
    createWritable: async () => ({ write: async () => {}, close: async () => { throw abort(); }, abort: async () => {} }) });
  await run('save');
  assert.match(els.status.textContent, /^Failed: .*Safe Browsing/, 'blocked write shown as a cancel');
  picker = async () => { throw abort(); };
  await run('save');
  assert.strictEqual(els.status.textContent, '', 'cancelled picker reported as a failure');
}
// Popup: a click made while the script-access probe is still pending (page loading) must still capture, not be dropped.
{
  const sent = [];
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: () => new Promise(() => {}) }, // probe waits for document_idle
    runtime: { sendMessage: async m => { sent.push(m); } },
  };
  globalThis.document = { querySelectorAll: () => [], getElementById: () => ({}) };
  globalThis.window = { close() {} };
  import('./extension/popup.js');
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(typeof document.onclick, 'function', 'popup click handler waits for the probe');
  await document.onclick({ target: { dataset: { mode: 'visible' } } });
  assert.deepStrictEqual(sent, [{ mode: 'visible', tab: { id: 7 } }]);
}
// Editing text in a light swatch (White/Yellow) must not sit on #edit's near-white CSS background.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8');
  const line = src.match(/Object\.assign\(edit\.style, .*/)[0];
  const run = s => { const edit = { style: {} }; new Function('edit', 's', 'k', 'p', 'W', 'off', 'shot', 'LH', line)(edit, s, 1, 0, 100, { x: 0, y: 0 }, { naturalHeight: 100 }, 1.2); return edit.style; };
  assert.strictEqual(run({ x: 0, y: 0, size: 16, c: '#ffffff' }).background, '#000c', 'white text gets a dark edit background');
  assert.strictEqual(run({ x: 0, y: 0, size: 16, c: '#fdd835' }).background, '#000c', 'yellow text gets a dark edit background');
  assert.notStrictEqual(run({ x: 0, y: 0, size: 16, c: '#e53935' }).background, '#000c', 'red keeps the default light background');
}
// A huge paste (150k lines) or pen stroke must not overflow the spread-args limit.
{
  const big = Array.from({ length: 150000 }, (_, i) => [i, 1 - i]);
  assert.deepStrictEqual(bounds({ pts: big }), { l: 0, t: -149998, r: 149999, b: 1 }, 'bounds of a 150k-point stroke');
  const line = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8').match(/if \(text\) shapes\[i\] = .*/)[0];
  const shapes = [{}], measure = { measureText: l => ({ width: l.length * 10 }) };
  new Function('shapes', 'i', 'text', 'measure', line)(shapes, 0, 'ab\n' + '\n'.repeat(150000), measure);
  assert.strictEqual(shapes[0].em, 0.2, 'finishEdit measures a 150k-line text');
}
// A callout dragged up-left of its point grows away from the point, not back over it.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8').match(/function finishEdit[\s\S]*?\n}/)[0];
  const shapes = [{ type: 'callout', size: 10, x: 60, y: 60, text: '', em: 0, tip: [100, 100] }], measure = { measureText: l => ({ width: l.length * 60 }) };
  new Function('shapes', 'measure', 'bounds', 'commit', 'edit', `let editing = 0, cur = 0; ${src}; finishEdit();`)(shapes, measure, bounds, () => {}, { value: 'abcdefgh\nx' });
  const b = bounds(shapes[0]);
  assert.ok(b.r <= 100 && b.b <= 100, 'callout box covers its own point');
}
// Editing a text whose top is under the fixed header scrolls it clear of the header.
{
  const src = (await import('node:fs')).readFileSync('./extension/result.js', 'utf8').match(/function startEdit[\s\S]*?\n}/)[0];
  let dy = 0;
  const edit = { focus() {}, getBoundingClientRect: () => ({ top: 30 }) };
  new Function('shapes', 'edit', 'render', 'header', 'scrollBy', `let editing, cur; ${src}; startEdit(0);`)([{ text: 'a' }], edit, () => {}, { offsetHeight: 50 }, (x, y) => { dy += y; });
  assert.strictEqual(dy, -20, 'startEdit scrolls the editor out from under the header');
}
console.log('ok');
