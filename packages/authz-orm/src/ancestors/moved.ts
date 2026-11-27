import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { OrmDriver, RowChange } from '@spinajs/orm';

import { changeBusOf, ormDomain } from '../host.js';
import { idText } from '../ids.js';
import type { ResourceEntry } from '../registry.js';
import { SYSTEM_REF } from './cleanup.js';
import { afterCommit } from './commit.js';

/** Past this many moved rows one change carries `*`, as a membership write does past MEMBERSHIP_TAG_LIMIT. */
const MOVE_TAG_LIMIT = 1000;

/** Ids of the rows that existed before the write and hold another `@Parent` value after it, compared as the table stores it. */
export function movedRows(entry: ResourceEntry, rows: readonly RowChange[]): string[] {
  const moved = ({ before, after }: RowChange): boolean => before !== undefined && after !== undefined && entry.parents.some((p) => idText(before[p.column]) !== idText(after[p.column]));
  return rows.filter(moved).map((r) => r.id);
}

/**
 * After the outermost commit, one change on the domain's bus. A cached decision carries the `scope:` tag of its resource
 * and of each ancestor, so `scope:<moved row>` drops the decisions below it, and every type-level read (`scope:*`) with them.
 */
export async function publishMoved(driver: OrmDriver, moved: readonly ResourceRef[]): Promise<void> {
  if (moved.length === 0) return;
  const domain = ormDomain();
  const tags = moved.length > MOVE_TAG_LIMIT ? ['*'] : [...new Set(moved.map((r) => `scope:${resourceKey(r)}`))];
  await afterCommit(driver, 'publishing the move', async () => {
    const bus = await changeBusOf(domain);
    await bus?.publish(Object.freeze({ domain, tags: Object.freeze(tags), actor: SYSTEM_REF, at: new Date() }));
  });
}
