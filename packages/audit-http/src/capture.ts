import { REDACTED, answeredAsServerError, redactFields, urlPath } from '@spinajs/http';
import type { IMiddlewareContext } from '@spinajs/http';
import { isPlainObject } from '@spinajs/util';

export interface IAuditError {
  name: string;
  /** Only for an error not answered as a 500, cut to 200 characters. */
  message?: string;
}

export interface ICapturedBody {
  body?: unknown;
  /** Size in bytes of a body over the limit, which is then not recorded. */
  bodyTruncated?: number;
}

const MAX_ERROR_MESSAGE = 200;

export const isEmptyObject = (v: unknown): boolean => isPlainObject(v) && Object.keys(v).length === 0;

export function captureBody(req: IMiddlewareContext['req'], redact: readonly string[], maxBodyBytes: number): ICapturedBody {
  const body: unknown = req.body;
  if (body === undefined || body === null || isEmptyObject(body)) return {};

  // A text body has no keys to redact by, so none of it is recorded.
  if (typeof body !== 'object') return { body: REDACTED };

  const declared = Number(req.headers['content-length']);
  if (declared > maxBodyBytes) return { bodyTruncated: declared };

  const redacted = redactFields(body, redact);
  const bytes = Buffer.byteLength(JSON.stringify(redacted) ?? '');
  return bytes > maxBodyBytes ? { bodyTruncated: bytes } : { body: redacted };
}

// A message of an error answered as a 500 can carry internals or quote input (a SyntaxError, a driver error with bound values).
export function describeError(error: unknown): IAuditError {
  const name = error instanceof Error ? (error.name !== 'Error' ? error.name : error.constructor.name) : typeof error;
  if (answeredAsServerError(error)) return { name };

  const message = error instanceof Error ? error.message : String(error);
  return { name, message: message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}...` : message };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `url` with every path segment that holds a route parameter of a sensitive name replaced by `[redacted]`. */
export function redactPathParams(url: string, params: Record<string, unknown>, sensitive: (key: string) => boolean): string {
  const values = Object.entries(params).flatMap(([key, value]) => (sensitive(key) && typeof value === 'string' && value !== '' ? [value] : []));
  if (values.length === 0) return url;

  const path = urlPath(url);
  const redacted = path
    .split('/')
    .map((segment) => (values.includes(decodeSegment(segment)) ? REDACTED : segment))
    .join('/');
  return redacted + url.slice(path.length);
}
