// A small PDF writer for quotes, invoices and credit notes (D17/D18) — no dependency.
//
// Why hand-rolled (not pdfkit): a document is one page or a few of text, lines and filled boxes, and the standard
// Helvetica fonts every PDF reader has built in (no font files: WinAnsi text, Adobe's published widths below). pdfkit
// would add fontkit and half a dozen packages for features not used here, and it writes asynchronously through a
// stream — this writer is synchronous, so issuing a document (its number, its PDF and its record) is ONE SQLite
// transaction, and it writes no dates or random ids, so the same document always gives the same bytes (tested).
//
// Units are points (1/72 in), US Letter (612 × 792), y measured from the top here and turned over when written.

const PAGE_W = 612;
const PAGE_H = 792;

// Helvetica and Helvetica-Bold widths for character codes 32–126 (Adobe's AFM, per 1000 units of the font size).
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// WinAnsi codes 128–159 (Windows-1252's extra characters).
const WIN_EXTRA = new Map(Object.entries({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}));
const EXTRA_W = { 0x80: [556, 556], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000] };
// Look-alikes for characters WinAnsi doesn't have (the minus sign Intl puts in negative money, odd spaces…).
const SUBSTITUTE = new Map(Object.entries({ '−': '-', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '‐': '-', '‑': '-', '‒': '-', '′': '\'', '″': '"' }));

/** One character → its WinAnsi code (63 "?" when there is none) and the base character used for its width. */
function encodeChar(ch) {
  const c = SUBSTITUTE.get(ch) ?? ch;
  const cp = c.codePointAt(0);
  if (cp >= 32 && cp <= 126) return { code: cp, base: c };
  if (cp === 0xa0) return { code: 32, base: ' ' };
  if (cp >= 0xa1 && cp <= 0xff) return { code: cp, base: c.normalize('NFD')[0] };
  if (WIN_EXTRA.has(c)) return { code: WIN_EXTRA.get(c), base: c.normalize('NFD')[0] };
  const plain = c.normalize('NFD')[0];
  const pc = plain.codePointAt(0);
  if (pc >= 32 && pc <= 126) return { code: pc, base: plain };
  return { code: 63, base: '?' };
}

/** Text → [WinAnsi codes] (tabs and line breaks become spaces; control characters dropped). */
export function encodeText(text) {
  const out = [];
  for (const ch of String(text ?? '').normalize('NFC')) {
    if (ch === '\t' || ch === '\n' || ch === '\r') out.push({ code: 32, base: ' ' });
    else if (ch.codePointAt(0) < 32) continue;
    else out.push(encodeChar(ch));
  }
  return out;
}

const charWidth = ({ code, base }, bold) => {
  if (code >= 32 && code <= 126) return (bold ? W_BOLD : W_REG)[code - 32];
  if (EXTRA_W[code]) return EXTRA_W[code][bold ? 1 : 0];
  const b = base.codePointAt(0);
  if (b >= 32 && b <= 126) return (bold ? W_BOLD : W_REG)[b - 32];
  return 556;
};

/** How wide a text is, in points, at a size (bold or not). */
export function textWidth(text, size, bold = false) {
  return (encodeText(text).reduce((a, c) => a + charWidth(c, bold), 0) * size) / 1000;
}

/** A PDF string: ASCII as is (with ( ) \ escaped), every other byte as an octal escape — the file stays plain ASCII. */
function pdfString(text) {
  let s = '(';
  for (const { code } of encodeText(text)) {
    if (code === 40 || code === 41 || code === 92) s += `\\${String.fromCharCode(code)}`;
    else if (code >= 32 && code <= 126) s += String.fromCharCode(code);
    else s += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return `${s})`;
}

const num = (n) => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};
/** "#1d6fa5" → "0.114 0.435 0.647" (an rgb for rg / RG); anything else → a dark grey. */
export function rgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''));
  const parts = m ? m.slice(1).map((h) => parseInt(h, 16) / 255) : [0.2, 0.2, 0.2];
  return parts.map((p) => (Math.round(p * 1000) / 1000).toString()).join(' ');
}
/** A colour mixed with white (0 = the colour, 1 = white): the table header's tint. */
export function tint(hex, amount) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''));
  if (!m) return '#eeeeee';
  return `#${m.slice(1).map((h) => Math.round(parseInt(h, 16) + (255 - parseInt(h, 16)) * amount).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Break text into lines no wider than `width` (words kept whole unless one alone is too wide; the text's own line
 * breaks kept). → [string]
 */
export function wrapText(text, width, size, bold = false) {
  const out = [];
  for (const para of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.split(/[ \t]+/).filter((w) => w.length);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (let w of words) {
      const tryLine = line ? `${line} ${w}` : w;
      if (textWidth(tryLine, size, bold) <= width) {
        line = tryLine;
        continue;
      }
      if (line) out.push(line);
      // A word wider than the line: cut it.
      while (textWidth(w, size, bold) > width) {
        let n = w.length;
        while (n > 1 && textWidth(w.slice(0, n), size, bold) > width) n -= 1;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

/** A page being drawn: its operators. */
class Page {
  constructor() {
    this.ops = [];
  }

  text(x, y, str, { size = 10, bold = false, color = '#222222', align = 'left' } = {}) {
    if (str === null || str === undefined || str === '') return;
    const w = textWidth(str, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${num(PAGE_H - y)} Td ${pdfString(str)} Tj ET`);
  }

  rect(x, y, w, h, color) {
    this.ops.push(`${rgb(color)} rg ${num(x)} ${num(PAGE_H - y - h)} ${num(w)} ${num(h)} re f`);
  }

  line(x1, y1, x2, y2, color = '#cccccc', width = 0.75) {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(PAGE_H - y1)} m ${num(x2)} ${num(PAGE_H - y2)} l S`);
  }

  /** Big light text across the page at an angle ("DRAFT"). */
  watermark(str, color = '#e6e6e6') {
    const size = 110;
    const w = textWidth(str, size, true);
    const a = Math.PI / 5;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const cx = PAGE_W / 2 - (w / 2) * cos;
    const cy = PAGE_H / 2 - (w / 2) * sin;
    this.ops.push(`q ${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(cx)} ${num(cy)} cm BT /F2 ${size} Tf ${rgb(color)} rg 0 0 Td ${pdfString(str)} Tj ET Q`);
  }
}

/**
 * Write the pages as a PDF file (Buffer): catalog, pages, the two standard fonts, an info dictionary (title, producer;
 * no dates and no id, so the same pages give the same bytes). Plain ASCII, uncompressed.
 */
export function writePdf(pages, { title = '', author = '' } = {}) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Producer (Skynet Corp Suite) >>`);
  const kids = [];
  for (const p of pages) {
    const stream = p.ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const PAGE = Object.freeze({ width: PAGE_W, height: PAGE_H });
export { Page };
