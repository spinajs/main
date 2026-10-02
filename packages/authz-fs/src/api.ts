import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import type { IProviderConfiguration, fs } from '@spinajs/fs';

// Takes the arguments so the stubs keep the design's parameter names under noUnusedParameters.
function notImplemented(name: string, ..._args: unknown[]): Error {
  return new Error(`@spinajs/authz-fs: ${name} is not implemented yet`);
}

// Mirrors the hook lane L7 adds to @spinajs/fs.
export abstract class FsDecorator {
  abstract readonly order: number;
  abstract decorate(instance: fs, config: IProviderConfiguration): fs;
}

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

// Structural so authz-fs needs no authz-http; assignable to its ResourceExtractor.
export function fromFsPath(fsName: string, param: string): (req: unknown) => ResourceRef | Promise<ResourceRef> {
  throw notImplemented('fromFsPath', fsName, param);
}
