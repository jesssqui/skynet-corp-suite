// Small fetch wrapper for the suite API. Same-origin: in development Vite
// proxies /api to the server, in production the server serves this app.
// The session is an HttpOnly cookie the browser sends by itself; every request
// also names this device (X-Suite-Device) so a signed-out device hears about it
// even after its cookie is gone.
import { getDeviceId } from '../auth/device.js';

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = body?.code ?? null;
  }
}

/** 401 codes that mean "no usable session here" (as opposed to a wrong password). */
export const SESSION_CODES = ['not_signed_in', 'session_expired', 'device_signed_out'];

/** Fired on window when any request finds the session gone: detail = { code }. */
export const SESSION_LOST_EVENT = 'suite:session-lost';

/** A request that gets no answer in this long counts as "can't reach the server" (a weak signal can hang for minutes). */
const TIMEOUT_MS = 30 * 1000;

async function request(method, url, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const deviceId = getDeviceId();
  if (deviceId) headers['X-Suite-Device'] = deviceId;
  let res;
  let text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    throw new ApiError(0, 'Can\'t reach the suite server', { cause: err.message });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const error = new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
    if (res.status === 401 && SESSION_CODES.includes(error.code)) {
      window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT, { detail: { code: error.code } }));
    }
    throw error;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  del: (url) => request('DELETE', url),
};
