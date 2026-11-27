import type { AuditQuery, AuditSubject, AuditTrail } from '@spinajs/audit';

import { HISTORY_OPS, LOST_SUBJECT_ID } from './encode.js';
import { toHistoryEntry } from './entry.js';
import { HistoryConfigError } from './errors.js';
import type { AsOf, HistoryEntry } from './types.js';
import type { HistorySpec } from './registry.js';

export const ROW_OPS = HISTORY_OPS.filter((o) => o !== 'lost');

interface Scope {
  readonly trail: AuditTrail;
  readonly source: string;
  readonly subject: AuditSubject;
}

export function assertInstant(name: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new HistoryConfigError(`orm-history: ${name} must be a valid Date`);
}

async function changes(scope: Scope, window: Pick<AuditQuery, 'to' | 'order' | 'limit'>): Promise<HistoryEntry[]> {
  const events = await scope.trail.of(scope.subject, { ...window, source: scope.source, kinds: ['data'], actions: ROW_OPS });
  return events.flatMap((e) => toHistoryEntry(e) ?? []);
}

/** An insert whose keys were never reported may have written this row without an entry. */
async function lostSince(scope: Scope, seq: number, at: Date): Promise<boolean> {
  const marks = await scope.trail.of({ type: scope.subject.type, id: LOST_SUBJECT_ID }, { source: scope.source, kinds: ['data'], actions: ['lost'], afterSeq: seq, to: at, limit: 1 });
  return marks.length > 0;
}

/** Whether the trail still holds an entry of the entity at or before `at`: retention prunes a time prefix, and tracking may start late. */
async function covers(scope: Scope, at: Date): Promise<boolean> {
  const held = await scope.trail.since(0, { source: scope.source, subjectType: scope.subject.type, kinds: ['data'], actions: ROW_OPS, to: at, limit: 1 });
  return held.length > 0;
}

export async function asOfFrom(trail: AuditTrail, spec: HistorySpec, source: string, id: string, at: Date): Promise<AsOf> {
  assertInstant('at', at);
  const scope: Scope = { trail, source, subject: { type: spec.entity, id } };
  const [last] = await changes(scope, { to: at, order: 'desc', limit: 1 });
  if (!last) {
    // The row did not exist yet when its first retained entry is its insert and the trail covers `at`; before that
    // cover, an insert and a delete that were pruned or never tracked may have made it present.
    const [first] = await changes(scope, { limit: 1 });
    return first?.op === 'insert' && (await covers(scope, at)) ? { state: 'absent', seq: null } : { state: 'unknown' };
  }
  if (await lostSince(scope, last.seq, at)) return { state: 'unknown' };
  if (last.op === 'delete') return { state: 'absent', seq: last.seq };
  if (last.redacted) return { state: 'redacted', seq: last.seq };
  return last.after ? { state: 'present', row: last.after, seq: last.seq } : { state: 'unknown' };
}
