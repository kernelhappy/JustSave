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
const src = (await import('node:fs')).readFileSync('./extension/background.js', 'utf8').match(/function freeze[\s\S]*?\r?\n}\r?\n/)[0];
const set = {}, el = { dataset: {}, getAttribute: () => null, style: { setProperty: (k, v) => { set[k] = v; } } };
const shadowEl = { dataset: {}, getAttribute: () => null, style: { setProperty() { shadowEl.frozen = true; } } };
const host = { shadowRoot: { querySelectorAll: () => [shadowEl] } }, win = {};
new Function('window', 'document', 'getComputedStyle', src + 'freeze(false);')(win, { body: { querySelectorAll: () => [el, host] } }, e => ({ position: e === host ? 'static' : 'sticky' }));
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
await new Promise(r => setTimeout(r, 10));
assert.strictEqual(dims.length, 1);
assert(dims[0][0] * dims[0][1] <= 268435456, 'stitch canvas ' + dims[0]);
// Fast capture: output is CSS size x devicePixelRatio x clip.scale, and must fit the canvas limits too (result.js re-encodes it).
let clip;
chrome.debugger = { attach: async () => {}, detach: async () => {}, sendCommand: async (t, m, p) =>
  m === 'Page.getLayoutMetrics' ? { cssContentSize: { width: 1200, height: 20000 } }
  : m === 'Runtime.evaluate' ? { result: { value: 2 } }
  : (clip = p.clip, { data: '' }) };
onMsg({ mode: 'fast', tab: { id: 3, index: 0, url: 'https://x.test/' } });
await new Promise(r => setTimeout(r, 10));
const out = [clip.width * 2 * clip.scale, clip.height * 2 * clip.scale];
assert(out[0] <= 32767 && out[1] <= 32767 && out[0] * out[1] <= 268435456, 'fast capture ' + out);
// Result tab handoff: open it in the source tab's current window (create rejects an opener in another window),
// and if it still can't open, drop the stored capture instead of orphaning it in IndexedDB.
const files = new Map();
globalThis.indexedDB = { open() { const o = {}; setTimeout(() => { o.result = { close() {}, transaction() {
  const tx = { objectStore: () => ({ put: (v, k) => (files.set(k, v), {}), delete: k => (files.delete(k), {}) }) };
  setTimeout(() => tx.oncomplete());
  return tx;
} }; o.onsuccess(); }); return o; } };
const created = [];
chrome.tabs.get = async () => ({ active: true, windowId: 7, index: 4 });
chrome.tabs.create = async p => { if (p.windowId !== 7) throw new Error('opener in another window'); created.push(p); };
onMsg({ mode: 'visible', tab: { id: 4, index: 0, windowId: 7, url: 'https://x.test/' } }); // create defaults to the focused window, not 7
await new Promise(r => setTimeout(r, 50));
assert.strictEqual(created.length, 1);
assert.strictEqual(created[0].index, 5);
assert.strictEqual(files.size, 1);
files.clear();
chrome.tabs.create = async () => { throw new Error('window closed'); };
onMsg({ mode: 'visible', tab: { id: 5, index: 0, windowId: 7, url: 'https://x.test/' } });
await new Promise(r => setTimeout(r, 50));
assert.strictEqual(files.size, 0, 'orphaned capture');
// Watchdog: if the service worker dies mid-capture (restore() never comes), block() must unlock the page by itself.
const bg = (await import('node:fs')).readFileSync('./extension/background.js', 'utf8'), fn = n => bg.match(new RegExp(String.raw`function ${n}\([\s\S]*?\r?\n}\r?\n`))[0];
let timer, shield = { style: {}, remove() { shield.gone = true; } };
const listeners = new Set(), page = { dataset: { justsave: 'color:red' }, setAttribute(k, v) { page.restored = v; } };
const doc = { createElement: () => shield, documentElement: { append() {} } };
new Function('window', 'document', 'addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', 'scrollTo', fn('block') + 'block();')(
  { justsaveFrozen: new Set([page]) }, doc, (t, f) => listeners.add(t), t => listeners.delete(t), f => (timer = f), () => { timer = null; }, () => {});
assert(timer, 'block() arms no watchdog');
timer();
assert(shield.gone && listeners.size === 0 && page.restored === 'color:red', 'watchdog left the page locked');
// fileName: file names reject control and format characters (ZWJ, RLM) that titles of host-less pages can carry.
const fileName = new Function(fn('fileName') + 'return fileName;')();
assert.doesNotMatch(fileName({ url: 'file:///x', title: 'a‍b‏cd' }), /[‍‏]/u);
// scrollThrough: stop when the page no longer scrolls (fractional zoom, unscrollable window) instead of looping 100x150ms.
const t0 = Date.now();
await new Function('document', 'scrollX', 'scrollY', 'innerHeight', 'scrollBy', 'setTimeout', 'async ' + fn('scrollThrough') + 'return scrollThrough();')(
  { documentElement: { scrollWidth: 800, scrollHeight: 5000 } }, 0, 0, 600, () => {}, setTimeout);
assert(Date.now() - t0 < 1000, 'scrollThrough kept waiting on a page that does not scroll');
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
console.log('ok');
