import { AuthzConfigError } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FileMetadataStore } from '../api.js';
import { fsAccessConfig } from '../config/index.js';
import type { FsAccessConfig } from '../config/index.js';

// A found store per container and class name; the config is still read on every call.
const found = new WeakMap<IContainer, Map<string, FileMetadataStore>>();

/**
 * The FileMetadataStore `authz.fs.<fsName>.metadata` names, by class name among the stores registered in DI under
 * FileMetadataStore; undefined when the entry names none.
 *
 * @throws AuthzConfigError when no registered store has that class name
 */
export async function fileMetadataStore(fsName: string, container: IContainer = DI.RootContainer, config: FsAccessConfig = fsAccessConfig(fsName, container)): Promise<FileMetadataStore | undefined> {
  const named = config.metadata;
  if (named === undefined) return undefined;
  const cached = found.get(container)?.get(named);
  if (cached) return cached;
  // resolveChain, not Array.ofType: it also returns instances registered through factories and those of parent containers.
  const registered = [...(await container.resolveChain(FileMetadataStore))] as FileMetadataStore[];
  const store = registered.find((s) => s.constructor.name === named);
  if (!store) {
    const known = registered.map((s) => s.constructor.name).join(', ') || 'none';
    throw new AuthzConfigError(`authz.fs.${fsName}.metadata names ${JSON.stringify(named)}, which is not a registered FileMetadataStore (registered: ${known})`);
  }
  if (!found.has(container)) found.set(container, new Map());
  found.get(container)!.set(named, store);
  return store;
}
