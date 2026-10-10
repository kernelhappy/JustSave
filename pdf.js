// Wraps one JPEG (base64) in a single-page PDF sized to the page's CSS dimensions. Returns base64.
// Works on binary strings (one char per byte) so offsets are just string lengths.
export function jpegToPdf(b64, cssW, cssH) {
  const jpg = atob(b64);
  const [pw, ph] = jpegSize(jpg);
  // PDF pages max out at 14400pt (200in); UserUnit scales long pages past that.
  const unit = Math.max(1, Math.ceil(Math.max(cssW, cssH) * 0.75 / 14400));
  const w = (cssW * 0.75 / unit).toFixed(2), h = (cssH * 0.75 / unit).toFixed(2);
  const content = `q ${w} 0 0 ${h} 0 0 cm /I Do Q`;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/UserUnit ${unit}/Resources<</XObject<</I 4 0 R>>>>/Contents 5 0 R>>`,
    `<</Type/XObject/Subtype/Image/Width ${pw}/Height ${ph}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>\nstream\n${jpg}\nendstream`,
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.6\n%\xE2\xE3\xCF\xD3\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return btoa(out);
}

// Pixel [width, height] from the JPEG's SOF segment.
export function jpegSize(s) {
  const u16 = i => s.charCodeAt(i) << 8 | s.charCodeAt(i + 1);
  for (let i = 2; i < s.length; i += 2 + u16(i + 2)) {
    const m = s.charCodeAt(i + 1);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [u16(i + 7), u16(i + 5)];
  }
  throw new Error('no JPEG SOF marker');
}
