// Files (D10) routes, all signed in (app.js puts requireSession in front):
//   POST /api/files/upload          the bytes (Content-Type application/octet-stream — the one non-JSON
//                                   body the guard lets through, for this exact path: `rawUploads`), with
//                                   X-File-Info = encodeURIComponent(JSON { id, name, clientId|accountId|taskId, notes? })
//                                   → 201 { file } (made) / 200 { file } (the same upload sent again)
//   GET  /api/files/:id/download    the bytes; ?inline=1 shows images and PDFs in the browser, everything
//                                   else is always an attachment (never rendered in the app's origin)
//   GET  /api/files/usage           space used and the limits (for the upload button)
// Nothing about a file (its name, its owner) is ever logged: names travel in a header, never in a
// path, and log lines say only an id, a size and a type.
import { once } from 'node:events';
import { Router } from 'express';
import { isInlineType, downloadName } from '@suite/shared/files';
import { HttpError } from '../../lib/httpError.js';
import { parseUploadInfo } from './service.js';

const MAX_AT_ONCE = 3;

/** RFC 6266 / 5987: an ASCII fallback and the UTF-8 name. */
export function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Read exactly `expected` bytes of the body (the size was checked before anything was read). */
function readBody(req, expected) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let got = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (c) => {
      got += c.length;
      if (got > expected) {
        fail(new HttpError(413, 'The file is bigger than it said', undefined, { code: 'too_big' }));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (got !== expected) reject(new HttpError(400, 'The upload was cut short: try again', undefined, { code: 'incomplete' }));
      else resolve(Buffer.concat(parts, got));
    });
    req.on('error', () => fail(new HttpError(400, 'The upload was cut short: try again', undefined, { code: 'incomplete' })));
    req.on('close', () => fail(new HttpError(400, 'The upload was cut short: try again', undefined, { code: 'incomplete' })));
  });
}

export function createFilesRouter(ctx, service) {
  const router = Router();
  let uploading = 0;

  router.get('/usage', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(service.usage());
  });

  router.post('/upload', async (req, res) => {
    const length = Number(req.get('content-length'));
    let info;
    let check;
    try {
      if (!req.is('application/octet-stream')) throw new HttpError(415, 'Send the file as application/octet-stream', undefined, { code: 'octet_stream_only' });
      if (req.get('transfer-encoding') || !Number.isSafeInteger(length)) throw new HttpError(411, 'Send the file’s size (Content-Length)', undefined, { code: 'length_required' });
      if (uploading >= MAX_AT_ONCE) throw new HttpError(503, 'Several uploads are already going: try again in a moment', undefined, { code: 'busy', headers: { 'Retry-After': '5' } });
      info = parseUploadInfo(req.get('x-file-info'));
      check = service.precheck({ ...info, size: length });
    } catch (err) {
      // Refused before reading the body: drain a body of a sensible size so the browser gets the answer;
      // close the connection after anything bigger instead of reading it.
      if (length > 0 && length <= ctx.config.files.maxFileBytes * 2) req.resume();
      else res.set('Connection', 'close');
      throw err;
    }
    uploading += 1;
    try {
      const bytes = await readBody(req, length);
      const { file, created } = service.store({ ...info, bytes, actor: req.auth.user.actor });
      res.status(created ? 201 : 200).set('Cache-Control', 'no-store').json({ file, existing: Boolean(check.existing) });
    } finally {
      uploading -= 1;
    }
  });

  router.get('/:id/download', async (req, res) => {
    const { record, blob } = service.forDownload(req.params.id);
    const inline = req.query.inline === '1' && isInlineType(record.content_type);
    res.set({
      'Content-Type': record.content_type,
      'Content-Length': String(blob.size),
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', downloadName(record.name, record.content_type)),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    // Nothing downloaded can run in the app's origin: a sandboxed document with no scripts. (An inline PDF keeps
    // the app's own CSP instead: browsers refuse to show a PDF in a sandboxed document.)
    if (!(inline && record.content_type === 'application/pdf')) {
      res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    }
    if (req.method === 'HEAD') return res.end();
    let closed = false;
    res.on('close', () => { closed = true; });
    for (let n = 0; n < blob.chunks && !closed; n++) {
      const data = service.chunk(blob.id, n);
      if (!data) {
        res.destroy(); // a piece is missing (shouldn't happen): never send a short file as if whole
        return undefined;
      }
      if (!res.write(data)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
    }
    return res.end();
  });

  return router;
}
