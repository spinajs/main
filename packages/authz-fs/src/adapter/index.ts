import { ResourceAdapter } from '@spinajs/authz';
import type { PermissionDef, ResourceRef, ResourceType } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FS_PERMISSIONS } from '../permissions/index.js';
import { FS_RESOURCE_TYPES, fsAncestors, fsRef, normalizeFsPath } from '../refs/index.js';
import type { FsPathKind } from '../refs/index.js';

export interface FsTarget {
  readonly fs: string;
  readonly path: string;
  /** Default 'file'. */
  readonly kind?: FsPathKind;
}

/** Refs, ancestors and permissions of the filesystems (design §13); registered in the root container. */
@Injectable(ResourceAdapter)
export class FsResourceAdapter extends ResourceAdapter<FsTarget> {
  readonly kind = 'fs';
  readonly types: readonly ResourceType[] = FS_RESOURCE_TYPES;

  /** Where the published fs providers are looked up. */
  constructor(protected readonly container: IContainer = DI.RootContainer) {
    super();
  }

  accepts(target: unknown): target is FsTarget {
    if (target === null || typeof target !== 'object') return false;
    const proto: unknown = Object.getPrototypeOf(target);
    if (proto !== Object.prototype && proto !== null) return false;
    const t = target as Record<string, unknown>;
    return typeof t.fs === 'string' && typeof t.path === 'string' && (t.kind === undefined || t.kind === 'file' || t.kind === 'dir');
  }

  refOf(target: FsTarget): ResourceRef {
    return fsRef(target.fs, normalizeFsPath(target.path, this.basePathOf(target.fs)), target.kind ?? 'file');
  }

  /** Does not know which filesystems exist, so an fs name with no provider still gets a chain (it grants nothing). */
  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return fsAncestors(ref);
  }

  permissions(): readonly Omit<PermissionDef, 'source'>[] {
    return FS_PERMISSIONS;
  }

  // Read from the published provider instance, so refOf does no IO; a guard proxy passes Options through.
  protected basePathOf(fsName: string): string | undefined {
    const providers: unknown = this.container.get('__file_provider_instance__');
    if (!(providers instanceof Map)) return undefined;
    const basePath: unknown = (providers.get(fsName) as { Options?: { basePath?: unknown } } | undefined)?.Options?.basePath;
    return typeof basePath === 'string' && basePath !== '' ? basePath : undefined;
  }
}
