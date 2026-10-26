import type * as express from 'express';
import { basename, dirname, resolve } from 'path';

export interface SendFileAtOptions {
  /** Set by `send` once it has found the file, so a 404 or a 500 never carries them. */
  headers?: Record<string, unknown>;
}

/**
 * `res.sendFile(absolutePath)` refuses a path with any dot-prefixed segment ( 404 / 500 ), so a provider rooted under
 * `~/.local`, `.config` or a CI work dir like `.claude` could never serve a file. With `root` only the part below it
 * is checked, which still refuses a hidden file name.
 */
export function sendFileAt(res: express.Response, file: string, done: (err?: Error) => void, options: SendFileAtOptions = {}): void {
  const absolute = resolve(file);
  res.sendFile(basename(absolute), { ...options, root: dirname(absolute) }, done);
}
