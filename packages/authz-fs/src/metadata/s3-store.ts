import { AuthzConfigError } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { FileMetadataStore } from '../api.js';
import type { FileMeta } from '../api.js';
import { rawFsOf } from '../guard/raw.js';
import { normalizeFsPath } from '../refs/index.js';
import { checkFileMeta, checkFsName } from './meta.js';

/** The S3 user metadata key (`x-amz-meta-authz-meta`); S3 lowercases keys. */
export const S3_FILE_META_KEY = 'authz-meta';
// S3 allows 2 KB of user metadata per object, keys and values together.
const S3_USER_METADATA_BYTES = 2048;

/** What the store needs of a provider: fsS3 of `@spinajs/fs-s3` has both methods. */
export interface S3MetadataProvider {
  getMetadata(path: string): Promise<Record<string, string> | undefined>;
  setMetadata(path: string, metadata: Record<string, string>): Promise<void>;
}

export interface S3ObjectMetadataStoreOptions {
  /** Where the published providers (`__file_provider_instance__`) are looked up; default the DI root. */
  readonly container?: IContainer;
}

/**
 * FileMeta in the user metadata of the S3 object itself, as one URI-encoded JSON value (ASCII, as S3 needs). The
 * metadata lives and dies with the object: fsS3.move within a bucket keeps it, rm drops it, and fsS3 write, upload
 * and append replace it (the guard writes it back). It reaches the raw provider of a guarded filesystem, so its own
 * reads are never checked. Whoever may PUT objects into the bucket directly (bucket credentials, a presigned PUT)
 * can set any owner.
 */
@Injectable(FileMetadataStore)
export class S3ObjectMetadataStore extends FileMetadataStore {
  constructor(private readonly opts: S3ObjectMetadataStoreOptions = {}) {
    super();
  }

  async get(fsName: string, path: string): Promise<FileMeta | null> {
    const p = normalizeFsPath(path);
    if (p === '') return null;
    const all = await this.read(fsName, p);
    const value = all?.[S3_FILE_META_KEY];
    return value === undefined ? null : decode(value, `${fsName}:${p}`);
  }

  async set(fsName: string, path: string, meta: FileMeta): Promise<void> {
    const p = normalizeFsPath(path);
    if (p === '') throw new InvalidArgument(`${fsName}: the filesystem root has no metadata`, 'path');
    const value = encodeURIComponent(JSON.stringify(checkFileMeta(meta)));
    const all = await this.read(fsName, p);
    if (all === null) throw new InvalidArgument(`${fsName}:${p} is not an object of the bucket, so it cannot hold metadata`, 'path');
    const next = { ...withoutMeta(all), [S3_FILE_META_KEY]: value };
    const bytes = Object.entries(next).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
    if (bytes > S3_USER_METADATA_BYTES) throw new InvalidArgument(`the metadata of ${fsName}:${p} would take ${bytes} bytes of S3 user metadata, over the limit of ${S3_USER_METADATA_BYTES}`, 'meta');
    await this.provider(fsName).setMetadata(p, next);
  }

  /** The destination object gets the source's FileMeta. When the source object is gone, the provider moved the object with its metadata, and nothing is left to do. */
  async move(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    const src = normalizeFsPath(from);
    const dst = normalizeFsPath(to);
    if (fromFs === toFs && src === dst) return;
    if ((await this.read(fromFs, src)) === null) return;
    const meta = await this.get(fromFs, src);
    if (meta) await this.set(toFs, dst, meta);
    else await this.delete(toFs, dst);
    await this.delete(fromFs, src);
  }

  async delete(fsName: string, path: string): Promise<void> {
    const p = normalizeFsPath(path);
    if (p === '') return;
    const all = await this.read(fsName, p);
    if (all === null || all[S3_FILE_META_KEY] === undefined) return;
    await this.provider(fsName).setMetadata(p, withoutMeta(all));
  }

  /** The object's user metadata, null when there is no such object. */
  private async read(fsName: string, path: string): Promise<Record<string, string> | null> {
    try {
      return (await this.provider(fsName).getMetadata(path)) ?? {};
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }

  private provider(fsName: string): S3MetadataProvider {
    checkFsName(fsName);
    const published: unknown = (this.opts.container ?? DI.RootContainer).get('__file_provider_instance__');
    const found = published instanceof Map ? (published.get(fsName) as unknown) : undefined;
    if (found === undefined || found === null) throw new AuthzConfigError(`S3ObjectMetadataStore: no filesystem named ${JSON.stringify(fsName)} is published`);
    const raw = rawFsOf(found) as Partial<S3MetadataProvider>;
    if (typeof raw.getMetadata !== 'function' || typeof raw.setMetadata !== 'function') {
      throw new AuthzConfigError(`S3ObjectMetadataStore: filesystem ${JSON.stringify(fsName)} has no getMetadata/setMetadata (fsS3 has both); use another FileMetadataStore for it`);
    }
    return raw as S3MetadataProvider;
  }
}

function withoutMeta(all: Record<string, string>): Record<string, string> {
  const { [S3_FILE_META_KEY]: _dropped, ...rest } = all;
  return rest;
}

function decode(value: string, at: string): FileMeta {
  try {
    return checkFileMeta(JSON.parse(decodeURIComponent(value)), `S3 metadata of ${at}`);
  } catch (e) {
    throw new AuthzConfigError(`S3 object ${at} holds unreadable ${S3_FILE_META_KEY} metadata: ${(e as Error).message}`, { cause: e });
  }
}

function notFound(e: unknown): boolean {
  const err = e as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return err !== null && typeof err === 'object' && (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404);
}
