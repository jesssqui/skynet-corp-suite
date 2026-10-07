// A small CSV reader for customer-list imports (C7), used by the server (the import itself) and
// the browser (headers and a sample for the column mapping). No dependency: RFC 4180 plus what
// real exports do — a byte-order mark, ";" or tab instead of ",", \r\n, \n or \r line ends, quoted
// fields with commas, quotes ("") and line breaks inside, spaces around values.

export class CsvError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const CANDIDATES = [',', ';', '\t'];

/**
 * The separator a file uses: the one of , ; tab found most often outside quotes in its first
 * record (ties go to the comma). Spreadsheets in many locales (Excel in French, German…) save ";".
 */
export function detectDelimiter(text) {
  const counts = new Map(CANDIDATES.map((c) => [c, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  }
  let best = ',';
  for (const c of CANDIDATES) if (counts.get(c) > counts.get(best)) best = c;
  return best;
}

/**
 * Text -> records (arrays of strings). Quoted fields keep everything inside them; unquoted ones
 * are trimmed. Blank lines are left out. `maxRecords` stops early with CsvError 'too_many_rows'.
 * @returns {{ records: string[][], delimiter: string }}
 */
export function parseCsv(input, { delimiter = null, maxRecords = Infinity } = {}) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte-order mark (Excel's "CSV UTF-8")
  const sep = delimiter ?? detectDelimiter(text);
  const records = [];
  let record = [];
  let field = '';
  let quoted = false; // inside "…"
  let wasQuoted = false; // this field had quotes (don't trim what was inside them)
  let i = 0;
  const endField = () => {
    record.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (record.length > 1 || record[0] !== '') {
      if (records.length >= maxRecords) throw new CsvError('too_many_rows', `More than ${maxRecords} rows`);
      records.push(record);
    }
    record = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      // An opening quote (spaces before it are dropped): the field is what is inside.
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (ch === sep) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      endRecord();
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else if (wasQuoted) {
      // Text after a closing quote ("abc" def): keep it, as spreadsheets do.
      if (ch.trim() !== '') field += ch;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field !== '' || wasQuoted || record.length) endRecord();
  return { records, delimiter: sep };
}

/**
 * The first record as headers and the rest as rows (each padded to the header count).
 * @returns {{ headers: string[], rows: string[][], delimiter: string }}
 */
export function readTable(text, { maxRows = Infinity } = {}) {
  const { records, delimiter } = parseCsv(text, { maxRecords: maxRows === Infinity ? Infinity : maxRows + 1 });
  if (!records.length) return { headers: [], rows: [], delimiter };
  const [first, ...rest] = records;
  const headers = first.map((h, i) => h.trim() || `Column ${i + 1}`);
  const width = Math.max(headers.length, ...rest.map((r) => r.length));
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  const rows = rest.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
  return { headers, rows, delimiter };
}
