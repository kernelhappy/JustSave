// US Letter, in points, with 0.5in margins.
export const PAGE_W = 612, PAGE_H = 792, MARGIN = 36;

// Builds a PDF with one image per page: [{ jpg: binary string, w, h }] (pixel dims),
// each scaled to the margin width and drawn from the top. Returns a binary string
// (one char per byte), so object offsets are just string lengths.
export function imagesToPdf(pages) {
  const dw = PAGE_W - 2 * MARGIN;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}]/Count ${pages.length}>>`,
  ];
  pages.forEach(({ jpg, w, h }, i) => {
    const n = 3 + i * 3, dh = h * dw / w;
    const content = `q ${dw} 0 0 ${dh.toFixed(2)} ${MARGIN} ${(PAGE_H - MARGIN - dh).toFixed(2)} cm /I Do Q`;
    objs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_W} ${PAGE_H}]/Resources<</XObject<</I ${n + 1} 0 R>>>>/Contents ${n + 2} 0 R>>`,
      `<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>\nstream\n${jpg}\nendstream`,
      `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    );
  });
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

// Page-break finder: in an RGBA band `rows` tall, the row with the fewest color changes
// along it (a gap between lines of text, even inside panels and cards); lowest wins ties.
export function quietRow(data, width, rows) {
  let best = 0, fewest = Infinity;
  for (let r = 0; r < rows; r++) {
    let edges = 0;
    for (let p = r * width * 4 + 4, end = (r + 1) * width * 4; p < end; p += 4)
      if (Math.abs(data[p] - data[p - 4]) + Math.abs(data[p + 1] - data[p - 3]) + Math.abs(data[p + 2] - data[p - 2]) > 24) edges++;
    if (edges <= fewest) { fewest = edges; best = r; }
  }
  return best;
}

// Paginate a canvas to Letter: each page is a band of it, cut at the least busy row in its bottom 20%.
export async function canvasToPdf(canvas, quality = 0.92) {
  const { width: W, height: H } = canvas, ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pageH = Math.round(W * (PAGE_H - 2 * MARGIN) / (PAGE_W - 2 * MARGIN)), band = Math.round(pageH * 0.2);
  const pages = [];
  for (let top = 0; top < H; ) {
    let end = Math.min(top + pageH, H);
    if (end < H) end += quietRow(ctx.getImageData(0, end - band, W, band).data, W, band) - band;
    const page = new OffscreenCanvas(W, end - top);
    page.getContext('2d').drawImage(canvas, 0, top, W, end - top, 0, 0, W, end - top);
    pages.push({ jpg: bin(await (await page.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer()), w: W, h: end - top });
    top = end;
  }
  // Plain loop: Uint8Array.from(string, fn) goes through the iterator and is ~50x slower on big PDFs.
  const pdf = imagesToPdf(pages), bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}

// ArrayBuffer -> binary string (one char per byte), chunked to stay under argument limits.
function bin(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return s;
}
