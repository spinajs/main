import type { PermissionRegistry } from '@spinajs/authz';

import type { LadderDef, RoleDef } from '../../contracts.js';
import type { RbacExtension, RbacExtensionFactory, RbacTables } from '../evaluate.js';
import type { GrantIndex } from '../grants.js';
import type { RoleEdge, RoleGraph } from '../roles.js';
import { checkImplies } from './implies.js';
import { compileLadders, ladderEdges } from './ladders.js';
import type { LadderIndex } from './ladders.js';

/**
 * Ladders for one model: the implicit edges and the rule 9 checks when the roles compile, the rank
 * tables as the `ladders` table. Without it a model has no ranks: `RoleDef.ladder` and the store's
 * ladders are ignored.
 */
export class LadderExtension implements RbacExtension {
  private readonly indexes = new WeakMap<GrantIndex, LadderIndex>();

  readonly extraEdges = (defs: ReadonlyMap<string, RoleDef>, ladders: readonly LadderDef[]): RoleEdge[] => {
    checkImplies(defs);
    return ladderEdges(defs, ladders);
  };

  compile(graph: RoleGraph, grants: GrantIndex, _registry: PermissionRegistry): void {
    this.index(graph, grants);
  }

  tables(graph: RoleGraph, grants: GrantIndex): RbacTables {
    return { ladders: this.index(graph, grants) };
  }

  /** The rank tables of `graph`, built once per grant index. */
  index(graph: RoleGraph, grants: GrantIndex): LadderIndex {
    let index = this.indexes.get(grants);
    if (!index) {
      index = compileLadders(graph, grants);
      this.indexes.set(grants, index);
    }
    return index;
  }
}

export const ladderExtension: RbacExtensionFactory = () => new LadderExtension();
