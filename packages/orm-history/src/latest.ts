import type { AuditQuery, AuditSubject, AuditTrail, StoredAuditEvent } from '@spinajs/audit';

import { ROW_OPS } from './as-of.js';
import { toHistoryEntry } from './entry.js';
import { HistoryConfigError } from './errors.js';
import type { HistoryEntry } from './types.js';

const PAGE = 1000;

// MySQL's utf8mb4_bin and MSSQL's BIN2 ignore trailing spaces, so the trail's last match of 'a' may be an event of 'a '.
async function lastOwn(trail: AuditTrail, subject: AuditSubject, query: AuditQuery): Promise<StoredAuditEvent | undefined> {
  const [last] = await trail.of(subject, query);
  if (last === undefined || last.subject?.id === subject.id) return last;
  const page = await trail.of(subject, { ...query, limit: PAGE });
  const own = page.find((event) => event.subject?.id === subject.id);
  if (own !== undefined || page.length < PAGE) return own;
  const [asked, other] = [subject.id, last.subject?.id].map((id) => JSON.stringify(id));
  throw new HistoryConfigError(`orm-history: the trail's subject_id comparison takes ${other} for ${asked} of ${subject.type}, and the last ${PAGE} entries it matches are not ${asked}'s`);
}

/**
 * The last row entry of each id, at or before `to` when given. One read per id on the trail's
 * `(subject_type, subject_id, seq)` index: an audit reader filters by one subject and has no grouped read.
 */
export async function latestOf(trail: AuditTrail, entity: string, source: string, ids: readonly string[], to?: Date): Promise<ReadonlyMap<string, HistoryEntry>> {
  const query: AuditQuery = { source, kinds: ['data'], actions: ROW_OPS, order: 'desc', limit: 1, ...(to === undefined ? {} : { to }) };
  const out = new Map<string, HistoryEntry>();
  for (const id of new Set(ids)) {
    const event = await lastOwn(trail, { type: entity, id }, query);
    const entry = event === undefined ? undefined : toHistoryEntry(event);
    if (entry !== undefined) out.set(id, entry);
  }
  return out;
}
