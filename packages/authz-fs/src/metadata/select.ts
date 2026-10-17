import { AuthzConfigError } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FileMetadataStore } from '../api.js';
import { fsAccessConfig } from '../access-config/index.js';
import type { FsAccessConfig } from '../access-config/index.js';
import { namesOf, resolveByName } from '../named.js';

// A found store per container and name; the config is still read on every call.
const found = new WeakMap<IContainer, Map<string, FileMetadataStore>>();

/**
 * The FileMetadataStore `authz.fs.<fsName>.metadata` names among the stores registered in DI under
 * FileMetadataStore (see resolveByName); undefined when the entry names none.
 *
 * @throws AuthzConfigError when no registered store has that name
 */
export async function fileMetadataStore(fsName: string, container: IContainer = DI.RootContainer, config: FsAccessConfig = fsAccessConfig(fsName, container)): Promise<FileMetadataStore | undefined> {
  const named = config.metadata;
  if (named === undefined) return undefined;
  const cached = found.get(container)?.get(named);
  if (cached) return cached;
  const store = await resolveByName(container, FileMetadataStore, named);
  if (!store) {
    const known = (await namesOf(container, FileMetadataStore)).join(', ') || 'none';
    throw new AuthzConfigError(`authz.fs.${fsName}.metadata names ${JSON.stringify(named)}, which is not a registered FileMetadataStore (registered: ${known})`);
  }
  if (!found.has(container)) found.set(container, new Map());
  found.get(container)!.set(named, store);
  return store;
}
