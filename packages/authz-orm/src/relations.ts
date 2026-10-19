import { RelationResolver, resourceKey } from '@spinajs/authz';
import type { Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';

import { idText } from './ids.js';
import { classesOf, entryOf, namedRelation, registeredTypes } from './registry.js';
import { findRows } from './rows.js';

type Row = ModelBase & Record<string, unknown>;

/** The subject when it is the row of `ref`, else that row loaded as SYSTEM; null when there is none. */
async function rowFor(type: ResourceType, ref: ResourceRef, subject: unknown): Promise<Row | null> {
  if (ref.id === undefined || ref.id === null) return null;
  if (subject instanceof ModelBase) {
    const entry = entryOf(subject.constructor);
    if (entry?.type === type && idText((subject as Row)[entry.idColumn]) === String(ref.id)) return subject as Row;
  }
  return ((await findRows([ref])).get(resourceKey(ref))?.row as Row | undefined) ?? null;
}

class ColumnRelation extends RelationResolver {
  readonly listable = true;

  constructor(readonly type: ResourceType, readonly relation: string) {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
    if (typeof principal?.type !== 'string' || typeof principal.id !== 'string') return false;
    const row = await rowFor(this.type, ref, subject);
    if (row === null) return false;
    const entry = entryOf(row.constructor)!;
    if (this.relation === 'self') return principal.type === 'user' && entry.self !== undefined && idText(row[entry.self.column]) === principal.id;
    const columns = this.relation === 'owner' ? entry.owner : namedRelation(entry, this.relation);
    if (columns === undefined || idText(row[columns.column]) !== principal.id) return false;
    // Without a type column the column holds user ids.
    return columns.typeColumn === undefined ? principal.type === 'user' : row[columns.typeColumn] === principal.type;
  }
}

/** `owner`, `self` and every `@Relation` name per type that has such a column. */
export function ormRelations(): readonly RelationResolver[] {
  const out: RelationResolver[] = [];
  for (const type of registeredTypes()) {
    const entries = classesOf(type).map((c) => entryOf(c)!);
    if (entries.some((e) => e.owner !== undefined)) out.push(new ColumnRelation(type, 'owner'));
    if (entries.some((e) => e.self !== undefined)) out.push(new ColumnRelation(type, 'self'));
    for (const name of new Set(entries.flatMap((e) => Object.keys(e.relations ?? {})))) out.push(new ColumnRelation(type, name));
  }
  return out;
}
