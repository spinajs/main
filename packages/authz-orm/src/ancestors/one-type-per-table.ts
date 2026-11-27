import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import { extractModelDescriptor } from '@spinajs/orm';

import { classesOf, nameOf, registeredTypes } from '../registry.js';
import type { ModelClass } from '../registry.js';

/**
 * The write observer rewrites a row's links for the written class's type only, and a rebuild reads a table once per type:
 * two types on one table leave links that writes through the other type's classes never correct.
 */
export function checkOneTypePerTable(): void {
  const first = new Map<string, { cls: ModelClass; type: ResourceType }>();
  for (const type of registeredTypes()) {
    for (const cls of classesOf(type)) {
      // Read as tableOf does, without its throw: a class with no table yet must not fail the boot.
      const table = extractModelDescriptor(cls)?.TableName;
      if (typeof table !== 'string' || table === '') continue;
      const seen = first.get(table);
      if (seen === undefined) first.set(table, { cls, type });
      else if (seen.type !== type) throw new AuthzConfigError(`authz-orm: @AccessResource models ${nameOf(seen.cls)} (resource '${seen.type}') and ${nameOf(cls)} (resource '${type}') map to one table '${table}'; a write keeps authz_resource_ancestor for the written model's type only and a rebuild writes every row of the table as both types, so the links of one type go stale: use one resource type per table (register both classes as '${seen.type}'), or map '${type}' to a table of its own`);
    }
  }
}
