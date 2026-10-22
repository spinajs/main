import { AuthzConfigError } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { driverOf } from '../ids.js';
import { entryOf, nameOf } from '../registry.js';

/** The bulk move of design §6.4: one update; AncestorMiddleware recomputes the moved subtrees in its transaction. */
export async function reparent(model: Class<ModelBase>, ids: readonly (string | number)[], newParentId: string | number | null, column?: string): Promise<number> {
  const entry = entryOf(model);
  if (!entry) throw new AuthzConfigError(`reparent: ${nameOf(model)} is not an @AccessResource model`);
  const parent = column === undefined ? (entry.parents.length === 1 ? entry.parents[0] : undefined) : entry.parents.find((p) => p.column === column);
  if (!parent) {
    const names = entry.parents.map((p) => p.column).join(', ') || 'none';
    throw new AuthzConfigError(`reparent: ${nameOf(model)} ${column === undefined ? 'has several @Parent columns; name one' : `has no @Parent column ${column}`} (its @Parent columns: ${names})`);
  }
  if (ids.length === 0) return 0;
  const records = model as unknown as typeof ModelBase;
  return driverOf(model).transaction(async () => (await records.update({ [parent.column]: newParentId }).whereIn(entry.idColumn, [...ids])).RowsAffected);
}
