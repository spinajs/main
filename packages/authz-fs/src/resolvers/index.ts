import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FsPathResolver } from '../api.js';
import { fsAccessConfig } from '../config/index.js';

/**
 * Domain parents of a path, nearest first, without repeats. They come from the FsPathResolver that
 * `authz.fs.<fsName>.resolver` names by class name, or, without that key, from every registered resolver whose
 * `fs` matches the name, in registration order. A resolver answering null adds nothing.
 */
export async function resolveFsParents(fsName: string, path: string, container: IContainer = DI.RootContainer): Promise<readonly ResourceRef[]> {
  const named = fsAccessConfig(fsName, container).resolver;
  const registered = ((await container.resolve(Array.ofType(FsPathResolver))) ?? []) as FsPathResolver[];

  let resolvers: FsPathResolver[];
  if (named !== undefined) {
    const resolver = registered.find((r) => r.constructor.name === named);
    if (!resolver) throw new AuthzConfigError(`authz.fs.${fsName}.resolver names ${JSON.stringify(named)}, which is not a registered FsPathResolver`);
    resolvers = [resolver];
  } else {
    resolvers = registered.filter((r) => servesFs(r.fs, fsName));
  }

  const parents: ResourceRef[] = [];
  const seen = new Set<string>();
  for (const resolver of resolvers) {
    const found: unknown = await resolver.parents(fsName, path);
    if (found === null) continue;
    if (!Array.isArray(found) || !found.every(isInstanceRef)) {
      throw new AuthzConfigError(`FsPathResolver ${resolver.constructor.name} gave ${JSON.stringify(found)} for ${fsName}:${path}; expected null or a list of refs with a type and an id`);
    }
    for (const ref of found) {
      const key = resourceKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      parents.push(ref);
    }
  }
  return parents;
}

function servesFs(pattern: string | RegExp, fsName: string): boolean {
  if (typeof pattern === 'string') return pattern === fsName;
  // A /g or /y RegExp carries lastIndex from one test() to the next.
  pattern.lastIndex = 0;
  return pattern.test(fsName);
}

const isInstanceRef = (ref: unknown): ref is ResourceRef => ref !== null && typeof ref === 'object' && typeof (ref as ResourceRef).type === 'string' && typeof (ref as ResourceRef).id === 'string' && (ref as ResourceRef).id !== '';
