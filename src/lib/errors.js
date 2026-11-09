// One error format for every service:
// { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] }, "requestId": "..." }

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message) => new HttpError(409, 'CONFLICT', message);

export function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details) body.error.details = details;
  const requestId = res.req?.get?.('x-request-id');
  if (requestId) body.requestId = requestId;
  res.status(status).json(body);
}

export function notFoundHandler(req, res) {
  sendError(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`);
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return sendError(res, err.status, err.code, err.message, err.details);
  }
  if (err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (err.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  // Never leak stack traces or internal messages to clients.
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
}
