import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { parseFsRef } from '../refs/index.js';
import type { FsRefType } from '../refs/index.js';
import { FS_NO_OWNER_TYPES } from './meta.js';
import { fileMetadataStore } from './select.js';

/**
 * `owner` on fs refs (design §8.2, D10): holds when the FileMetadataStore of the ref's filesystem records the
 * principal (`{ type, id }`) as the owner of that path. The subject is ignored: a caller-built subject could claim
 * any owner. The filesystem root and filesystems without a store have no owner.
 */
export class FsOwnerRelation extends RelationResolver {
  readonly relation = 'owner';

  constructor(
    readonly type: FsRefType,
    /** Where the Configuration and the stores are resolved. */
    protected readonly container: IContainer = DI.RootContainer,
  ) {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef): Promise<boolean> {
    if (ref?.type !== this.type || FS_NO_OWNER_TYPES.has(principal.type)) return false;
    const parsed = parseFsRef(ref);
    if (!parsed || parsed.path === '') return false;
    const store = await fileMetadataStore(parsed.fs, this.container);
    if (!store) return false;
    const owner = (await store.get(parsed.fs, parsed.path))?.owner;
    return owner !== undefined && owner.type === principal.type && owner.id === principal.id;
  }
}
