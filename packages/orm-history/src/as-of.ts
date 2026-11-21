import type { AuditQuery, AuditSubject, AuditTrail } from '@spinajs/audit';

import { HISTORY_OPS, LOST_SUBJECT_ID } from './encode.js';
import { toHistoryEntry } from './entry.js';
import type { AsOf, HistoryEntry } from './types.js';
import type { HistorySpec } from './registry.js';

const ROW_OPS = HISTORY_OPS.filter((o) => o !== 'lost');

interface Scope {
  readonly trail: AuditTrail;
  readonly source: string;
  readonly subject: AuditSubject;
}

async function changes(scope: Scope, window: Pick<AuditQuery, 'to' | 'order' | 'limit'>): Promise<HistoryEntry[]> {
  const events = await scope.trail.of(scope.subject, { ...window, source: scope.source, kinds: ['data'], actions: ROW_OPS });
  return events.flatMap((e) => toHistoryEntry(e) ?? []);
}

/** An insert whose keys were never reported (H7) may have written this row without an entry. */
async function lostSince(scope: Scope, seq: number, at: Date): Promise<boolean> {
  const marks = await scope.trail.of({ type: scope.subject.type, id: LOST_SUBJECT_ID }, { source: scope.source, kinds: ['data'], actions: ['lost'], afterSeq: seq, to: at, limit: 1 });
  return marks.length > 0;
}

export async function asOfFrom(trail: AuditTrail, spec: HistorySpec, source: string, id: string, at: Date): Promise<AsOf> {
  const scope: Scope = { trail, source, subject: { type: spec.entity, id } };
  const [last] = await changes(scope, { to: at, order: 'desc', limit: 1 });
  if (!last) {
    // Nothing at or before `at`: the row did not exist yet if its history starts with its insert; otherwise the start was pruned or never written.
    const [first] = await changes(scope, { limit: 1 });
    return first?.op === 'insert' ? { state: 'absent', seq: null } : { state: 'unknown' };
  }
  if (await lostSince(scope, last.seq, at)) return { state: 'unknown' };
  if (last.op === 'delete') return { state: 'absent', seq: last.seq };
  if (last.redacted) return { state: 'redacted', seq: last.seq };
  return last.after ? { state: 'present', row: last.after, seq: last.seq } : { state: 'unknown' };
}
