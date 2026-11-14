import type { IRFragment, RelationDef, TypeDef } from '@spinajs/authz-ir';

import { entryOf, nameOf, registeredClasses } from './registry.js';
import type { ModelClass, OwnerColumns, ResourceEntry } from './registry.js';

export interface OrmIROptions {
  /** Default: every registered `@AccessResource` class. */
  readonly classes?: readonly ModelClass[];
  /** Subject types of an owner or `@Relation` column with a type column; default `['user']`. */
  readonly principalTypes?: readonly string[];
}

/**
 * Column-derived tuplesets (G3), one fragment per registered class (`orm:<Class>`): `@Parent` is `parent`
 * (with several parent columns, `parent_<column>` each plus `parent` read from the ancestor closure), `@Owner`
 * is `owner`, `@Self` is `self` and `@Relation(name)` is `name`, all read from the row, never from a tuple
 * table. Inherited decorators and `registerAccessResource` options are included, as `entryOf` merges them.
 */
export function ormToIR(options: OrmIROptions = {}): IRFragment[] {
  const out: IRFragment[] = [];
  for (const cls of options.classes ?? registeredClasses()) {
    const entry = entryOf(cls);
    if (entry !== undefined) out.push({ model: `orm:${nameOf(cls)}`, types: { [entry.type]: typeOf(entry, nameOf(cls), options.principalTypes ?? ['user']) } });
  }
  return out;
}

function typeOf(entry: ResourceEntry, model: string, principalTypes: readonly string[]): TypeDef {
  const relations: Record<string, RelationDef> = {};
  const column = (c: string, typeColumn?: string): RelationDef['source'] => ({ kind: 'column', model, column: c, ...(typeColumn === undefined ? {} : { typeColumn }) });
  const principal = (c: OwnerColumns): RelationDef => ({ allowed: c.typeColumn === undefined ? ['user'] : [...principalTypes], source: column(c.column, c.typeColumn) });
  if (entry.parents.length === 1) relations.parent = { allowed: [entry.parents[0].type], source: column(entry.parents[0].column) };
  if (entry.parents.length > 1) {
    for (const p of entry.parents) relations[`parent_${p.column}`] = { allowed: [p.type], source: column(p.column) };
    relations.parent = { allowed: [...new Set(entry.parents.map((p) => p.type))], source: { kind: 'ancestor', via: 'orm' } };
  }
  if (entry.owner !== undefined) relations.owner = principal(entry.owner);
  if (entry.self !== undefined) relations.self = { allowed: ['user'], source: column(entry.self.column) };
  for (const [name, c] of Object.entries(entry.relations ?? {})) relations[name] = principal(c);
  return { relations, permissions: {} };
}
