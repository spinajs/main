import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';

import { classesOf, oneTypePerTableMessage, registeredTypes, tableKey } from '../registry.js';
import type { ModelClass } from '../registry.js';

/**
 * The write observer rewrites a row's links for the written class's type only, and a rebuild reads a table once per type:
 * two types on one table leave links that writes through the other type's classes never correct.
 */
export function checkOneTypePerTable(): void {
  const first = new Map<string, { cls: ModelClass; type: ResourceType }>();
  for (const type of registeredTypes()) {
    for (const cls of classesOf(type)) {
      // A class with no table yet must not fail the boot.
      const table = tableKey(cls);
      if (table === undefined) continue;
      const seen = first.get(table);
      if (seen === undefined) first.set(table, { cls, type });
      else if (seen.type !== type) throw new AuthzConfigError(oneTypePerTableMessage(seen.cls, seen.type, cls, type));
    }
  }
}
