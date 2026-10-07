// Throw one of these from a route to send a JSON error with a status code.
// Express 5 passes errors from async handlers to the error handler automatically.
//   code     a stable machine-readable reason the client can act on (e.g. 'device_signed_out')
//   headers  extra response headers (e.g. Retry-After)
export class HttpError extends Error {
  constructor(status, message, details, { code, headers } = {}) {
    super(message);
    this.status = status;
    this.details = details;
    if (code) this.code = code;
    if (headers) this.headers = headers;
  }
}
