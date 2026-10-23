import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { InvalidArgument, InvalidOperation, LimitExceeded } from '@spinajs/exceptions';

/** Passes every byte on unchanged and hashes it on the way. */
export class DigestStream extends Transform {
  private readonly hash: Hash;
  private seen = 0;
  private result?: Buffer;

  constructor(algorithm = 'sha256') {
    super();
    this.hash = createHash(algorithm);
  }

  public get bytes(): number {
    return this.seen;
  }

  /** @throws InvalidOperation before the stream finished, since the digest covers the whole input */
  public digest(encoding: 'hex' | 'base64' = 'hex'): string {
    if (!this.result) {
      throw new InvalidOperation('DigestStream: the digest is known only after the stream finished');
    }
    return this.result.toString(encoding);
  }

  public _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.seen += chunk.length;
    callback(null, chunk);
  }

  public _flush(callback: TransformCallback): void {
    this.result = this.hash.digest();
    callback();
  }
}

/** Passes at most `maxBytes` bytes on; the chunk that would go over fails the stream with LimitExceeded and is dropped. */
export class ByteLimitStream extends Transform {
  private passed = 0;

  constructor(private readonly maxBytes: number) {
    super();
    // NaN or a fraction would never compare as over the limit and let any size through.
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new InvalidArgument(`ByteLimitStream: maxBytes must be a non-negative integer, got ${maxBytes}`, 'maxBytes');
    }
  }

  /** Bytes passed on so far; never more than `maxBytes`. */
  public get bytes(): number {
    return this.passed;
  }

  public _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.passed + chunk.length > this.maxBytes) {
      callback(new LimitExceeded(`The stream went over its limit of ${this.maxBytes} bytes`));
      return;
    }
    this.passed += chunk.length;
    callback(null, chunk);
  }
}
