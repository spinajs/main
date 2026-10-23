import type { IncomingMessage, ServerResponse } from 'node:http';
import { finished } from 'node:stream';

const DIGITS = /^\d+$/;

/** The request's Content-Length; undefined when it is absent (a chunked body) or not a plain integer. */
export function declaredLength(req: IncomingMessage): number | undefined {
  const value = req.headers['content-length'];
  if (value === undefined || !DIGITS.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

/**
 * Lets a refusal reach a client whose body was not read. An answer sent while the client is still sending resets the
 * connection on its side, even when the server resumes the request right after answering or answers with
 * `Connection: close`; only reading the body off before answering lets the client see the answer. So a body that
 * declares at most `bound` bytes is read off first; any other body still in flight gets `Connection: close` instead.
 */
export async function settleUnreadBody(req: IncomingMessage, res: ServerResponse, bound: number): Promise<void> {
  // req.complete: the whole message, body included, is already off the socket, so the answer cannot reset it.
  if (req.complete || req.readableEnded || req.destroyed) return;
  const length = declaredLength(req);
  if (length === undefined || length > bound) {
    if (!res.headersSent) res.setHeader('Connection', 'close');
    return;
  }
  await new Promise<void>((resolve) => {
    // finished() keeps its listeners after the callback unless its cleanup is called.
    const cleanup = finished(req, () => {
      cleanup();
      resolve();
    });
    req.unpipe();
    req.resume();
  });
}
