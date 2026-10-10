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
console.log('ok');
