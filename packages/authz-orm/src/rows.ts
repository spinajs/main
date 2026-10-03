import { AuthzConfigError, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { ModelBase, extractModelDescriptor } from '@spinajs/orm';

import { columnOf, dialectOf, idMode, idText, idValue } from './columns.js';
import { classesOf } from './registry.js';
import type { ModelClass } from './registry.js';

export type Row = ModelBase & Record<string, unknown>;

export function pkOf(model: ModelClass): string {
  const pk = extractModelDescriptor(model as never)?.PrimaryKey;
  const name = Array.isArray(pk) ? pk[0] : pk;
  if (typeof name !== 'string' || name === '') throw new AuthzConfigError(`authz-orm: model ${model.name} has no primary key`);
  return name;
}

/** The row of `ref` among the classes of its type (registration order), loaded unscoped; null when none has it. */
export async function findRow(ref: ResourceRef): Promise<Row | null> {
  if (ref.id === undefined || ref.id === null) return null;
  const id = String(ref.id);
  for (const cls of classesOf(ref.type)) {
    const pk = pkOf(cls);
    const column = columnOf(cls, pk);
    if (!column) continue;
    const mode = idMode(column, dialectOf(extractModelDescriptor(cls as never)));
    const value = idValue(mode, id, column);
    if (value === undefined) continue;
    const model = cls as unknown as typeof ModelBase;
    const query = () => model.where(pk, value).first() as Promise<unknown>;
    const row = await runWithPrincipal(SYSTEM, query);
    if (row instanceof ModelBase && idText(mode, (row as Row)[pk]) === id) return row as Row;
  }
  return null;
}
