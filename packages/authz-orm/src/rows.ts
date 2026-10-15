import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';

import { ID_CHUNK, chunks } from './ancestors/table.js';
import { idLookup, idText, refKey } from './ids.js';
import { classesOf, entryOf } from './registry.js';
import type { ModelClass } from './registry.js';

export interface FoundRow {
  readonly model: ModelClass;
  readonly row: ModelBase;
}

type Queryable = typeof ModelBase & { query(): { whereIn(column: string, values: unknown[]): Promise<ModelBase[]> } };

/**
 * Rows of `refs` by resourceKey, loaded as SYSTEM: per type, the classes of the type in registration
 * order, one query per class and id chunk; the first class that has an id wins.
 */
export async function findRows(refs: readonly ResourceRef[]): Promise<Map<string, FoundRow>> {
  const out = new Map<string, FoundRow>();
  const byType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (r.id === undefined || r.id === null) continue;
    const ids = byType.get(r.type) ?? new Set<string>();
    ids.add(String(r.id));
    byType.set(r.type, ids);
  }
  await runWithPrincipal(SYSTEM, async () => {
    for (const [type, ids] of byType) {
      for (const cls of classesOf(type)) {
        const entry = entryOf(cls)!;
        const wanted = [...ids].filter((id) => !out.has(refKey({ type, id })));
        const values = wanted.map((id) => idLookup(cls, entry.idColumn, id)).filter((v) => v !== undefined);
        for (const part of chunks(values, ID_CHUNK)) {
          if (part.length === 0) continue;
          const rows = await (cls as Queryable).query().whereIn(entry.idColumn, part);
          for (const row of rows) {
            const id = idText((row as unknown as Record<string, unknown>)[entry.idColumn]);
            if (id !== undefined && ids.has(id) && !out.has(refKey({ type, id }))) out.set(refKey({ type, id }), { model: cls, row });
          }
        }
      }
    }
  });
  return out;
}
