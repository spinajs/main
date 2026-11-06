import type { Class } from '@spinajs/di';
import type { RelationType } from './interfaces.js';
import type { IOrmRelation } from './relations.js';
import { OrmException } from './exceptions.js';

/** A relation descriptor's `Type`, or `recursive` for a `@BelongsTo` that points at its own model. */
export type RelationKind = RelationType | 'recursive';

// builders/select.ts builds relations from here instead of importing relations.ts, which imports
// the middlewares, the relation objects and through them the builders back.
const RELATIONS = new Map<RelationKind, Class<IOrmRelation>>();

export function registerRelation(kind: RelationKind, type: Class<IOrmRelation>): void {
  RELATIONS.set(kind, type);
}

export function relationOf(kind: RelationKind): Class<IOrmRelation> {
  const type = RELATIONS.get(kind);
  if (type === undefined) {
    throw new OrmException(`no relation class is registered for ${String(kind)}; import @spinajs/orm, not a single module of it`);
  }
  return type;
}
