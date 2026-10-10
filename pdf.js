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
