import { AuthzConfigError } from '@spinajs/authz';
import { extractModelDescriptor } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../ancestors/table.js';
import { entryOf, namedRelation, nameOf, registeredClasses } from '../registry.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import type { RlsResource } from './generate.js';

/** The relation columns of `entry` as RLS terms read them. */
export function entryRelation(entry: ResourceEntry): RlsResource['relations'] {
  return (name) => (name === 'owner' ? entry.owner : name === 'self' ? entry.self : namedRelation(entry, name));
}

/** The registered models with `rls`, each with its table; a class registered twice through inheritance counts once per table. */
export function rlsResources(classes: readonly ModelClass[] = registeredClasses()): { readonly model: string; readonly connection?: string; readonly resource: RlsResource }[] {
  const out: { model: string; connection?: string; resource: RlsResource }[] = [];
  for (const model of classes) {
    const entry = entryOf(model);
    if (entry?.rls === undefined) continue;
    const descriptor = extractModelDescriptor(model);
    if (!descriptor?.TableName) throw new AuthzConfigError(`authz:rls: ${nameOf(model)} (resource '${entry.type}') has no table`);
    out.push({
      model: nameOf(model),
      ...(descriptor.Connection ? { connection: descriptor.Connection } : {}),
      resource: { type: entry.type, table: descriptor.TableName, idColumn: entry.idColumn, relations: entryRelation(entry), ancestorTable: AUTHZ_RESOURCE_ANCESTOR_TABLE, mode: entry.rls },
    });
  }
  return out;
}
