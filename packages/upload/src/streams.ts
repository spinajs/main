import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

/** Passes every byte on and keeps the first `limit` of them, for the content check of part 1 (spec §4.3). */
export class HeadCapture extends Transform {
  private readonly chunks: Buffer[] = [];

  private captured = 0;

  constructor(private readonly limit: number) {
    super();
  }

  public get head(): Buffer {
    return Buffer.concat(this.chunks, this.captured);
  }

  public _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.captured < this.limit) {
      const take = chunk.subarray(0, this.limit - this.captured);
      this.chunks.push(Buffer.from(take));
      this.captured += take.length;
    }
    done(null, chunk);
  }
}

/**
 * Resolves on 'close'. fs holds that event back until its after-middlewares ran (fs/src/actions.ts:188-215), and fs-s3
 * emits it after upload.done() (fs-s3/src/index.ts:500-531); 'finish' would report an object not yet committed.
 */
export function closed(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('close', () => resolve());
  });
}
