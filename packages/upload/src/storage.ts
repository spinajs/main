import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Config, InvalidConfiguration } from '@spinajs/configuration';
import { AsyncService, Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, LimitExceeded } from '@spinajs/exceptions';
import { ByteLimitStream, DigestStream, fsService, publishedFs } from '@spinajs/fs';
import type { IWriteStreamOptions, fs } from '@spinajs/fs';
import { Log, Logger } from '@spinajs/log';
import { DateTime } from 'luxon';

import { UploadError } from './errors.js';
import type { BlobKind } from './models/UploadBlob.js';
import type { UploadPart } from './models/UploadPart.js';
import type { UploadSession } from './models/UploadSession.js';
import { UploadStore } from './store.js';
import { HeadCapture, closed } from './streams.js';
import type { UploadConfig } from './types.js';

/** Anything else could make the prefix rm reach beyond the session folder. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** Whether the object's row was deleted here, was already deleted by a concurrent remover, or is kept after a failed rm. */
export type ObjectRemoval = 'removed' | 'gone' | 'kept';

export interface WrittenPart {
  readonly blobId: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  /** The first upload.detect.headBytes bytes of part 1; empty for the other parts. */
  readonly head: Buffer;
}

export interface AssemblyTarget {
  readonly dir: string;
  readonly contentType: string;
  readonly declaredSha256: string | null;
}

export interface AssembledFile {
  readonly blobId: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  /** Parts whose stored bytes no longer hash to their row's sha256, or that could not be read. */
  readonly corrupted: readonly number[];
}

interface OpenObject {
  readonly blobId: string;
  readonly provider: fs;
  readonly key: string;
  readonly out: Writable;
  readonly sessionId: string;
}

const EXTENSION = /^\.[a-z0-9]{1,16}$/;

function extensionOf(name: string): string {
  const ext = posix.extname(name).toLowerCase();
  return EXTENSION.test(ext) ? ext : '';
}

const hashMetadata = (hash: string | null | undefined): Pick<IWriteStreamOptions, 'metadata'> => (hash === undefined || hash === null ? {} : { metadata: { hash } });

/**
 * A refused write does not consume its source (plan 2). A Readable is drained, not destroyed: destroying an
 * IncomingMessage resets the socket, and the client would never see the error response.
 */
function abandon(body: NodeJS.ReadableStream): void {
  if (body instanceof Readable) body.resume();
  else if (typeof (body as { destroy?: unknown }).destroy === 'function') (body as unknown as Readable).destroy();
  else body.resume();
}

const logFields = (fsName: string, key: string, error: unknown, uploadId?: string) => (uploadId === undefined ? { fs: fsName, key, error } : { uploadId, fs: fsName, key, error });

/** getFs throws a bare ResolveException for an unknown name (fs/src/index.ts:96-100); a boot error should name the providers. */
export function assertFsProviders(names: Iterable<string>): void {
  const missing = [...new Set(names)].filter((name) => publishedFs(name) === undefined);
  if (missing.length > 0) {
    throw new InvalidConfiguration(`upload: file provider(s) ${missing.join(', ')} are not defined in fs.providers`);
  }
}

/**
 * Every fs call of the upload. It uses only exclusive writeStream, readStream, rm and exists, never mkdir, append, rename,
 * move or list (spec §6.3): an exclusive writeStream creates its parent directories (fs/src/local-provider.ts:189-221).
 * Every object goes to a new key and is recorded in upload_blobs before it is written (spec D10, D13).
 */
@Singleton()
@Injectable()
export class UploadStorage extends AsyncService {
  @Config('upload')
  protected Options: UploadConfig;

  @Logger('upload')
  protected Log: Log;

  @Autoinject(UploadStore)
  protected Store: UploadStore;

  public async resolve(): Promise<void> {
    await super.resolve();
    // fsService publishes the providers (fs/src/index.ts:66-77); it resolves once, so this is a no-op once the app has resolved it.
    await DI.resolve(fsService);
    assertFsProviders([this.Options.fs.temp, this.Options.fs.files]);
  }

  public provider(name: string): fs {
    const provider = publishedFs(name);
    if (!provider) throw new InvalidConfiguration(`upload: file provider ${name} is not defined in fs.providers`);
    return provider;
  }

  public isValidSessionId(sessionId: string): boolean {
    return SESSION_ID.test(sessionId);
  }

  /** Every part key of the session starts with it (spec §4.1 step 6). */
  public sessionPrefix(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new InvalidArgument('upload session id must be non-empty and made of letters, digits, _ and -');
    return `${this.Options.fs.prefix}/${sessionId}`;
  }

  public partKey(sessionId: string, part: number): string {
    return `${this.sessionPrefix(sessionId)}/${String(part).padStart(5, '0')}-${randomUUID()}`;
  }

  /** A `..` segment is refused: a provider may resolve it and write outside the directory. A backslash separates too, as fsNative does on Windows. */
  public fileKey(dir: string, name: string): string {
    if (dir.split(/[\\/]/).includes('..')) throw new InvalidArgument(`upload file directory ${dir} must not contain a .. segment`);
    return `${dir.replace(/^\/+|\/+$/g, '')}/${randomUUID()}${extensionOf(name)}`;
  }

  /**
   * Spec §4.1 step 2. A short body is returned as it is: the service compares the size, as it owns the codes and events.
   * Callers bound the body: its length must equal the expected part size, as a refused body is drained without a cap.
   */
  public async writePart(session: UploadSession, part: number, body: NodeJS.ReadableStream, expected: number, declaredSha256?: string): Promise<WrittenPart> {
    let target: OpenObject;
    let limit: ByteLimitStream;
    try {
      // Built first: an invalid `expected` throws here, before anything is opened or recorded.
      limit = new ByteLimitStream(expected);
      target = await this.open(session.id, session.temp_fs, this.partKey(session.id, part), 'part', { exclusive: true, ...hashMetadata(declaredSha256) });
    } catch (err) {
      abandon(body);
      throw err;
    }
    const digest = new DigestStream();
    const head = new HeadCapture(part === 1 ? this.Options.detect.headBytes : 0);
    try {
      await this.pour(target, [body, limit, digest, head]);
    } catch (err) {
      if (err instanceof LimitExceeded) throw new UploadError('upload.part_too_large', `part ${part} is longer than ${expected} bytes`);
      throw err;
    }
    return { blobId: target.blobId, key: target.key, size: digest.bytes, sha256: digest.digest('hex'), head: head.head };
  }

  /** Spec §4.2. The target blob stays 'writing': the service decides what becomes of it. */
  public async assemble(session: UploadSession, parts: readonly UploadPart[], target: AssemblyTarget): Promise<AssembledFile> {
    const source = this.provider(session.temp_fs);
    const options: IWriteStreamOptions = { exclusive: true, contentType: target.contentType, ...hashMetadata(target.declaredSha256) };
    const file = await this.open(session.id, session.files_fs, this.fileKey(target.dir, session.name), 'file', options);
    const whole = new DigestStream();
    const corrupted: number[] = [];
    await this.pour(file, [Readable.from(this.verifiedParts(source, parts, corrupted)), whole]);
    return { blobId: file.blobId, key: file.key, size: whole.bytes, sha256: whole.digest('hex'), corrupted };
  }

  /** Garbage first, so a crash before the rm leaves a row for the sweeper (spec §4.1 step 5). Never throws. */
  public async discard(blobId: string, fsName: string, key: string, uploadId?: string): Promise<void> {
    try {
      // False means the sweeper already took the row; removing the object again is harmless.
      await this.Store.setBlobState(blobId, ['writing', 'live'], 'garbage', DateTime.utc());
    } catch (err) {
      this.Log.warn(logFields(fsName, key, err, uploadId), 'Upload object ${key} on ${fs} could not be marked garbage');
      return;
    }
    await this.removeObject(blobId, fsName, key, uploadId);
  }

  /** Best effort: a failure keeps the garbage row, which the sweeper removes later. 'gone' means a concurrent remover deleted the row first. */
  public async removeObject(blobId: string, fsName: string, key: string, uploadId?: string): Promise<ObjectRemoval> {
    try {
      await this.provider(fsName).rm(key);
      return (await this.Store.deleteBlob(blobId)) ? 'removed' : 'gone';
    } catch (err) {
      this.Log.warn(logFields(fsName, key, err, uploadId), 'Upload object ${key} on ${fs} was not removed; the sweeper removes it');
      return 'kept';
    }
  }

  /** One rm of the session prefix (spec §9): recursive on fsNative, every key under it on fs-s3 (F4). Best effort. */
  public async removePrefix(fsName: string, sessionId: string): Promise<boolean> {
    if (!SESSION_ID.test(sessionId)) {
      this.Log.warn({ uploadId: sessionId, fs: fsName }, 'Upload ${uploadId}: prefix on ${fs} not removed, the session id is not a valid folder name');
      return false;
    }
    const prefix = this.sessionPrefix(sessionId);
    try {
      await this.provider(fsName).rm(prefix);
      return true;
    } catch (err) {
      this.Log.warn(logFields(fsName, prefix, err, sessionId), 'Upload ${uploadId}: prefix ${key} on ${fs} was not removed');
      return false;
    }
  }

  public async removeGarbage(sessionId: string): Promise<void> {
    for (const blob of await this.Store.listBlobs(sessionId, 'garbage')) {
      await this.removeObject(blob.id, blob.fs, blob.key, sessionId);
    }
  }

  private async open(sessionId: string, fsName: string, key: string, kind: BlobKind, options: IWriteStreamOptions): Promise<OpenObject> {
    const provider = this.provider(fsName);
    const blobId = await this.track(sessionId, provider.Name, key, kind);
    try {
      return { blobId, provider, key, sessionId, out: await provider.writeStream(key, options) };
    } catch (err) {
      // Only the row goes: a refused exclusive write means whatever is at the key is not ours to remove.
      await this.forget(blobId, provider.Name, key, sessionId);
      throw err;
    }
  }

  /** On any failure the blob is discarded; a partial object the rm cannot remove stays recorded as garbage. */
  private async pour(target: OpenObject, streams: (NodeJS.ReadableStream | NodeJS.ReadWriteStream)[]): Promise<void> {
    try {
      // The pipeline's first error is the cause; a target that substitutes its own error in _destroy must not win the race.
      const done = closed(target.out);
      done.catch(() => undefined);
      await pipeline([...streams, target.out]);
      await done;
    } catch (err) {
      await this.discard(target.blobId, target.provider.Name, target.key, target.sessionId);
      throw err;
    }
  }

  private async track(sessionId: string, fsName: string, key: string, kind: BlobKind): Promise<string> {
    const id = randomUUID();
    await this.Store.insertBlob({ id, session_id: sessionId, fs: fsName, key, kind }, DateTime.utc());
    return id;
  }

  private async forget(blobId: string, fsName: string, key: string, uploadId?: string): Promise<void> {
    try {
      await this.Store.deleteBlob(blobId);
    } catch (err) {
      this.Log.warn(logFields(fsName, key, err, uploadId), 'Upload blob row of ${key} on ${fs} was not deleted');
    }
  }

  /** Yields the parts in order while each one hashes to its stored sha256 (spec §4.2); after a mismatch it only hashes the rest. */
  private async *verifiedParts(source: fs, parts: readonly UploadPart[], corrupted: number[]): AsyncGenerator<Buffer> {
    for (const part of parts) {
      const intact = yield* this.readPart(source, part, corrupted.length === 0);
      if (!intact) corrupted.push(part.number);
    }
  }

  private async *readPart(source: fs, part: UploadPart, forward: boolean): AsyncGenerator<Buffer, boolean> {
    const hash = createHash('sha256');
    try {
      for await (const chunk of await source.readStream(part.storage_key)) {
        const bytes = chunk as Buffer;
        hash.update(bytes);
        if (forward) yield bytes;
      }
    } catch (err) {
      this.Log.warn({ uploadId: part.session_id, part: part.number, error: err }, 'Upload ${uploadId}: stored part ${part} cannot be read');
      return false;
    }
    return hash.digest('hex') === part.sha256;
  }
}
