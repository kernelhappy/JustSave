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
  action: { setBadgeText() {} },
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
new Function('document', 'getComputedStyle', src + 'freeze(false);')({ querySelectorAll: () => [el] }, () => ({ position: 'sticky' }));
assert.strictEqual(set.position, 'relative');
for (const k of ['top', 'right', 'bottom', 'left']) assert.strictEqual(set[k], 'auto', k);
// Stitch canvas: when the area limit binds, independently rounding each side up must not exceed it (Chrome rejects the canvas).
const dims = [];
globalThis.OffscreenCanvas = class { constructor(w, h) { dims.push([w, h]); } getContext() { return { fillRect() {}, drawImage() {} }; } convertToBlob() { return {}; } };
globalThis.createImageBitmap = async () => ({ width: 8297 }); // 5531 CSS px at 150%
globalThis.fetch = async () => ({ blob: async () => ({}) });
chrome.tabs = { get: async () => ({ active: true }), captureVisibleTab: async () => '', create() {} };
chrome.scripting.executeScript = async ({ func }) => [{ result: func.name === 'scrollToXY' ? { x: 0, y: 0, vw: 5531, vh: 21715, iw: 5531 } : { x: 0, y: 0, w: 5531, h: 21715 } }];
onMsg({ mode: 'visible', tab: { id: 2, index: 0, url: 'https://x.test/' } });
await new Promise(r => setTimeout(r, 10));
assert.strictEqual(dims.length, 1);
assert(dims[0][0] * dims[0][1] <= 268435456, 'stitch canvas ' + dims[0]);
console.log('ok');
