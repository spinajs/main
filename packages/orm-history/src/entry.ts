import type { StoredAuditEvent } from '@spinajs/audit';
import { isPlainObject, isStringArray } from '@spinajs/util';

import { HISTORY_OPS } from './encode.js';
import type { HistoryOp } from './encode.js';
import type { HistoryEntry } from './types.js';

const isOp = (v: string): v is HistoryOp => HISTORY_OPS.some((o) => o === v);

/** The history view of an audit event; undefined for an event that is not a recorded row change. */
export function toHistoryEntry(event: StoredAuditEvent): HistoryEntry | undefined {
  if (event.kind !== 'data' || event.subject === undefined || !isOp(event.action)) return undefined;
  // A redacted event keeps who, when and what kind of change; its payload is whatever the store left, so it is not read.
  const data: Readonly<Record<string, unknown>> = event.redacted ? {} : event.data;
  return {
    seq: event.seq,
    at: event.at,
    entity: event.subject.type,
    id: event.subject.id,
    op: event.action,
    before: isPlainObject(data.before) ? data.before : null,
    after: isPlainObject(data.after) ? data.after : null,
    changed: isStringArray(data.changed) ? data.changed : [],
    actor: event.actor,
    onBehalfOf: event.onBehalfOf ?? null,
    traceId: event.traceId ?? null,
    redacted: event.redacted,
  };
}
