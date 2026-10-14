// Sending a file's bytes (D10): one POST /api/files/upload per file, the raw bytes with the file's
// name and owner in a header. XMLHttpRequest rather than fetch, for the progress bar. Each picked
// file gets its record id once (kept with the File object), so trying again after a lost answer is
// the same upload — the server answers it with the file it already made, never a second copy.
import { getDeviceId } from '../../auth/device.js';
import { SESSION_CODES, SESSION_LOST_EVENT } from '../../api/client.js';
import { newId } from '@suite/shared/ids';
import { uploadInfoHeader } from './logic.js';

const ids = new WeakMap();
/** The record id for this picked file (made once). */
export function uploadIdFor(file) {
  if (!ids.has(file)) ids.set(file, newId());
  return ids.get(file);
}

/**
 * @param {{ file: File, owner: { field, id }, notes?: string, onProgress?: (fraction) => void }} opts
 * @returns {Promise<{ status: number, body: object|null }>} status 0 = no connection
 */
export function uploadFile({ file, owner, notes, onProgress }) {
  const id = uploadIdFor(file);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-File-Info', uploadInfoHeader({ id, name: file.name, owner, notes }));
    const device = getDeviceId();
    if (device) xhr.setRequestHeader('X-Suite-Device', device);
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60 * 1000;
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status === 401 && SESSION_CODES.includes(body?.code)) {
        window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT, { detail: { code: body.code } }));
      }
      resolve({ status: xhr.status, body, id });
    };
    xhr.onerror = () => resolve({ status: 0, body: null, id });
    xhr.ontimeout = () => resolve({ status: 0, body: null, id });
    xhr.onabort = () => resolve({ status: 0, body: null, id });
    xhr.send(file);
  });
}
