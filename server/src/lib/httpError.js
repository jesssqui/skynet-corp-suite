// Throw one of these from a route to send a JSON error with a status code.
// Express 5 passes errors from async handlers to the error handler automatically.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
