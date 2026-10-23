import { PassThrough, type Readable } from 'node:stream';
import { IOFail } from '@spinajs/exceptions';
import { ByteLimitStream } from '@spinajs/fs';

/**
 * The request body through a ByteLimitStream: the returned stream errors with LimitExceeded once `maxBytes` is passed,
 * with the request's own error when the request fails, and with IOFail when the request closes before its body ended.
 *
 * When reading stops early (the limit, or a consumer that destroyed the stream), the rest of the body is read off and
 * dropped, and the limit error is raised only once the request has ended, as body-parser does
 * (body-parser/lib/read.js:128-137,240-247). A client that is still sending would otherwise get a reset connection
 * instead of the error answer. `pipe()` is used because `stream.pipeline` would destroy `req` on a downstream error,
 * and that destroys its socket.
 */
export function limitRequestStream(req: Readable, maxBytes: number): Readable {
  const limiter = new ByteLimitStream(maxBytes);
  const out = new PassThrough();
  let failAfterEnd: (() => void) | null = null;

  const discardRest = () => {
    req.unpipe(limiter);
    if (!req.readableEnded && !req.destroyed) req.resume();
  };
  const onRequestError = (err: Error) => out.destroy(err);
  const onRequestClose = () => {
    if (!req.readableEnded) out.destroy(new IOFail('request closed before its body ended'));
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

  req.on('error', onRequestError);
  req.on('close', onRequestClose);
  limiter.on('error', onLimiterError);
  out.once('close', () => {
    req.off('error', onRequestError);
    req.off('close', onRequestClose);
    if (failAfterEnd) req.off('end', failAfterEnd);
    limiter.off('error', onLimiterError);
    discardRest();
    limiter.destroy();
  });

  req.pipe(limiter).pipe(out);
  return out;
}
