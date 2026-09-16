import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import { DateTime } from 'luxon';

export function fileExtension(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

/**
 * Timestamped so an upload never overwrites a repo-owned default or an earlier upload.
 */
export function storedFileName(originalName: string, uploadedAt: DateTime): string {
  const extension = fileExtension(originalName);
  const base = basename(originalName, extname(originalName)).replace(/[^\w.-]/g, '_');
  const stamp = uploadedAt.toUTC().toFormat('yyyyMMdd-HHmmss');

  return extension ? `${base}-${stamp}.${extension}` : `${base}-${stamp}`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }

  return hash.digest('hex');
}
