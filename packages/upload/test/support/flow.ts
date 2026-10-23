import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { UploadError } from '../../src/index.js';

/** Lowercase letters: neither file-type nor a test detector recognises them, and notes.txt declares text/plain. */
export function text(size: number, seed = 0): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = 97 + ((i * 7 + seed) % 26);
  return bytes;
}

export const sha256hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export const sha256raw = (bytes: Buffer): Buffer => createHash('sha256').update(bytes).digest();

export const bodyOf = (bytes: Buffer): NodeJS.ReadableStream => Readable.from([bytes], { objectMode: false });

export async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

export async function uploadErrorOf(work: Promise<unknown>): Promise<UploadError> {
  const e = await rejection(work);
  expect(e).to.be.instanceOf(UploadError);
  return e as UploadError;
}
