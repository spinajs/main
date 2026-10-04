import { AuthzConfigError, ResourceAdapter } from '@spinajs/authz';
import type { PermissionDef, ResourceRef, ResourceType } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FsPathResolver } from '../api.js';
import { fsAccessConfig } from '../config/index.js';
import { FS_PERMISSIONS } from '../permissions/index.js';
import { FS_RESOURCE_TYPES, fsAncestors, fsRef, normalizeFsPath, parseFsRef } from '../refs/index.js';
import type { FsPathKind } from '../refs/index.js';

export interface FsTarget {
  readonly fs: string;
  readonly path: string;
  /** Default 'file'. */
  readonly kind?: FsPathKind;
}

/** Lane D7: refs, ancestors and permissions of the filesystems; registered in the root container. */
@Injectable(ResourceAdapter)
export class FsResourceAdapter extends ResourceAdapter<FsTarget> {
  readonly kind = 'fs';
  readonly types: readonly ResourceType[] = FS_RESOURCE_TYPES;

  /** Where the Configuration, the fs providers and the FsPathResolvers are looked up. */
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

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    const parsed = parseFsRef(ref);
    if (!parsed) return null;
    return fsAncestors(ref, await this.resolverParents(parsed.fs, parsed.path));
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

  protected async resolverParents(fsName: string, path: string): Promise<ResourceRef[]> {
    const named = fsAccessConfig(fsName, this.container).resolver;
    const registered = ((await this.container.resolve(Array.ofType(FsPathResolver))) ?? []) as FsPathResolver[];

    let resolvers: FsPathResolver[];
    if (named !== undefined) {
      const resolver = registered.find((r) => r.constructor.name === named);
      if (!resolver) throw new AuthzConfigError(`authz.fs.${fsName}.resolver names ${JSON.stringify(named)}, which is not a registered FsPathResolver`);
      resolvers = [resolver];
    } else {
      resolvers = registered.filter((r) => servesFs(r.fs, fsName));
    }

    const parents: ResourceRef[] = [];
    for (const resolver of resolvers) {
      const found: unknown = await resolver.parents(fsName, path);
      if (found === null) continue;
      if (!Array.isArray(found) || !found.every(isInstanceRef)) {
        throw new AuthzConfigError(`FsPathResolver ${resolver.constructor.name} gave ${JSON.stringify(found)} for ${fsName}:${path}; expected null or a list of refs with a type and an id`);
      }
      parents.push(...found);
    }
    return parents;
  }
}

function servesFs(pattern: string | RegExp, fsName: string): boolean {
  if (typeof pattern === 'string') return pattern === fsName;
  // A /g or /y RegExp carries lastIndex from one test() to the next.
  pattern.lastIndex = 0;
  return pattern.test(fsName);
}

const isInstanceRef = (ref: unknown): ref is ResourceRef => ref !== null && typeof ref === 'object' && typeof (ref as ResourceRef).type === 'string' && typeof (ref as ResourceRef).id === 'string' && (ref as ResourceRef).id !== '';
