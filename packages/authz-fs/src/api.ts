import type { PrincipalRef, ResourceRef } from '@spinajs/authz';

export { FsDecorator } from '@spinajs/fs';
export { fromFsPath } from './http/from-fs-path.js';

export interface FileMeta {
  readonly owner?: PrincipalRef;
  readonly scope?: ResourceRef;
  readonly tags?: readonly string[];
}

export abstract class FileMetadataStore {
  abstract get(fsName: string, path: string): Promise<FileMeta | null>;
  abstract set(fsName: string, path: string, meta: FileMeta): Promise<void>;
  abstract move(fromFs: string, from: string, toFs: string, to: string): Promise<void>;
  abstract delete(fsName: string, path: string): Promise<void>;
}

export abstract class FsPathResolver {
  abstract readonly fs: string | RegExp;
  /** Domain parents of a path, nearest first; null = none. */
  abstract parents(fsName: string, path: string): Promise<readonly ResourceRef[] | null>;
}
