import type { AuditQuery, AuditTrail } from '@spinajs/audit';

import { ROW_OPS } from './as-of.js';
import { toHistoryEntry } from './entry.js';
import type { HistoryEntry } from './types.js';

/**
 * The last row entry of each id, at or before `to` when given. One read per id on the trail's
 * `(subject_type, subject_id, seq)` index: an audit reader filters by one subject and has no grouped read.
 */
export async function latestOf(trail: AuditTrail, entity: string, source: string, ids: readonly string[], to?: Date): Promise<ReadonlyMap<string, HistoryEntry>> {
  const query: AuditQuery = { source, kinds: ['data'], actions: ROW_OPS, order: 'desc', limit: 1, ...(to === undefined ? {} : { to }) };
  const out = new Map<string, HistoryEntry>();
  for (const id of new Set(ids)) {
    const [event] = await trail.of({ type: entity, id }, query);
    const entry = event === undefined ? undefined : toHistoryEntry(event);
    if (entry !== undefined) out.set(id, entry);
  }
  return out;
}
