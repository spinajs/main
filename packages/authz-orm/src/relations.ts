import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';

import { idText, refKey } from './ids.js';
import { classesOf, entryOf, registeredTypes } from './registry.js';
import { findRows } from './rows.js';

type Row = ModelBase & Record<string, unknown>;

/** The subject when it is the row of `ref`, else that row loaded as SYSTEM; null when there is none. */
async function rowFor(type: ResourceType, ref: ResourceRef, subject: unknown): Promise<Row | null> {
  if (ref.id === undefined || ref.id === null) return null;
  if (subject instanceof ModelBase) {
    const entry = entryOf(subject.constructor);
    if (entry?.type === type && idText((subject as Row)[entry.idColumn]) === String(ref.id)) return subject as Row;
  }
  return ((await findRows([ref])).get(refKey(ref))?.row as Row | undefined) ?? null;
}

class ColumnRelation extends RelationResolver {
  constructor(readonly type: ResourceType, readonly relation: 'owner' | 'self') {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
    if (typeof principal?.type !== 'string' || typeof principal.id !== 'string') return false;
    const row = await rowFor(this.type, ref, subject);
    if (row === null) return false;
    const entry = entryOf(row.constructor)!;
    if (this.relation === 'self') return principal.type === 'user' && entry.self !== undefined && idText(row[entry.self.column]) === principal.id;
    const owner = entry.owner;
    if (owner === undefined || idText(row[owner.column]) !== principal.id) return false;
    // Without a type column the owner column holds user ids (design §5).
    return owner.typeColumn === undefined ? principal.type === 'user' : row[owner.typeColumn] === principal.type;
  }
}

/** `owner` per type with an owner column, `self` per type with a self column. */
export function ormRelations(): readonly RelationResolver[] {
  const out: RelationResolver[] = [];
  for (const type of registeredTypes()) {
    const entries = classesOf(type).map((c) => entryOf(c)!);
    if (entries.some((e) => e.owner !== undefined)) out.push(new ColumnRelation(type, 'owner'));
    if (entries.some((e) => e.self !== undefined)) out.push(new ColumnRelation(type, 'self'));
  }
  return out;
}
