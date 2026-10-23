import { PassThrough, type Readable } from 'node:stream';
import { IOFail } from '@spinajs/exceptions';
import { ByteLimitStream } from '@spinajs/fs';

const ignoreError = () => undefined;

/**
 * The limit error waits until the rest of the body is read off, as body-parser does (body-parser/lib/read.js:128-137,240-247):
 * a client that is still sending would otherwise get a reset connection instead of the 413.
 * `pipe()` because `stream.pipeline` destroys `req` on a downstream error, and with it the socket.
 */
export function limitRequestStream(req: Readable, maxBytes: number): Readable {
  const closedEarly = () => new IOFail('request closed before its body ended');

  // A client abort during async middleware leaves `req` destroyed; it emits no more events to settle on.
  if (req.destroyed && !req.readableEnded) {
    const out = new PassThrough();
    out.on('error', ignoreError);
    out.destroy(req.errored ?? closedEarly());
    return out;
  }

  const limiter = new ByteLimitStream(maxBytes);
  const out = new PassThrough();
  // The action may await before it reads, and pipe() re-throws an error that `out` has no other listener for.
  // A reader that attaches later still gets the error: iterating or piping a destroyed stream rejects with it.
  out.on('error', ignoreError);
  let failAfterEnd: (() => void) | null = null;

  const discardRest = () => {
    req.unpipe(limiter);
    if (!req.readableEnded && !req.destroyed) req.resume();
  };
  const onRequestError = (err: Error) => out.destroy(err);
  const onRequestClose = () => {
    if (!req.readableEnded) out.destroy(closedEarly());
  };
  const onLimiterError = (err: Error) => {
    discardRest();
    if (req.readableEnded) {
      out.destroy(err);
      return;
    }
    failAfterEnd = () => out.destroy(err);
    req.once('end', failAfterEnd);
  };
  // Nobody reads the errors of a drain the consumer gave up on; without a listener a generic Readable would throw them.
  const drainUnobserved = () => {
    const stop = () => {
      req.off('error', ignoreError);
      req.off('end', stop);
      req.off('close', stop);
    };
    req.on('error', ignoreError);
    req.once('end', stop);
    req.once('close', stop);
  };

  req.on('error', onRequestError);
  req.on('close', onRequestClose);
  limiter.on('error', onLimiterError);
  out.once('close', () => {
    req.off('error', onRequestError);
    req.off('close', onRequestClose);
    if (failAfterEnd) req.off('end', failAfterEnd);
    // A LimitExceeded already queued on the limiter is still emitted after this point.
    limiter.off('error', onLimiterError);
    limiter.on('error', ignoreError);
    discardRest();
    if (!req.readableEnded && !req.destroyed) drainUnobserved();
    limiter.destroy();
  });

  req.pipe(limiter).pipe(out);
  return out;
}
