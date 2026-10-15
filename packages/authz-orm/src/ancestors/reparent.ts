import { AuthzConfigError } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { driverOf } from '../ids.js';
import { entryOf, nameOf } from '../registry.js';

type Updatable = typeof ModelBase & { update(v: object): { whereIn(column: string, values: unknown[]): Promise<unknown> } };

const affected = (r: unknown): number => {
  const n = (r as { RowsAffected?: unknown } | null)?.RowsAffected;
  return typeof n === 'number' ? n : 0;
};

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
  return driverOf(model).transaction(async () => affected(await (model as unknown as Updatable).update({ [parent.column]: newParentId }).whereIn(entry.idColumn, [...ids])));
}
