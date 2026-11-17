import { AUDIT_KINDS, AUDIT_OUTCOMES, AuditConfigError, canonicalJson, payloadHash } from '@spinajs/audit';
import type { AuditEvent, StoredAuditEvent } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { Orm, instantFromDb } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

// Keeps one INSERT of 18 columns (and the one or two a buffer or an archive adds) within the bind-parameter limit of every driver.
const INSERT_CHUNK = 50;

/** What a redacted payload is stored as; `data_hash` keeps the hash of the text it replaced. */
export const REDACTED_DATA = '';

/** A row of a trail table as a select without a model returns it: column names to driver values. */
export type AuditRow = Readonly<Record<string, unknown>>;

const isRow = (v: unknown): v is AuditRow => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const oneOf = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T => allowed.find((a) => a === v) ?? fallback;

export function findConnection(name: string): OrmDriver | undefined {
  return DI.get(Orm)?.Connections.get(name);
}

export function auditConnection(name: string): OrmDriver {
  const driver = findConnection(name);
  if (!driver) throw new AuditConfigError(`audit: no ORM connection ${JSON.stringify(name)}`);
  return driver;
}

/** The rows a select without a model resolved to. */
export function rowsOf(result: unknown): AuditRow[] {
  return Array.isArray(result) ? result.filter(isRow) : [];
}

/** The event columns of one event, `id` to `data_hash`: the payload as canonical JSON and its hash. */
export function storedColumns(event: AuditEvent): Record<string, unknown> {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    action: event.action,
    subject_type: event.subject?.type ?? null,
    subject_id: event.subject?.id ?? null,
    outcome: event.outcome,
    actor: event.actor,
    on_behalf_of: event.onBehalfOf ?? null,
    trace_id: event.traceId ?? null,
    origin: event.origin ?? null,
    tenant: event.tenant ?? null,
    decision_id: event.decisionId ?? null,
    idempotency_key: event.idempotencyKey ?? null,
    data_subject: event.dataSubject ?? null,
    data: canonicalJson(event.data),
    data_hash: payloadHash(event.data),
  };
}

/** Inserts in chunks; no statement for an empty list. A caller with columns of its own spreads `storedColumns(event)` into its row. */
export async function insertRows(driver: OrmDriver, table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
  // spinajs-orm-ignore ORM102: deliberate batching, one INSERT per INSERT_CHUNK rows
  for (let i = 0; i < rows.length; i += INSERT_CHUNK)
    await driver
      .insert()
      .into(table)
      .values(rows.slice(i, i + INSERT_CHUNK));
}

function payloadOf(raw: unknown): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'string') return isRow(raw) ? raw : {};
  if (raw === REDACTED_DATA) return {};
  const parsed: unknown = JSON.parse(raw);
  return isRow(parsed) ? parsed : {};
}

/** A redacted row (`data` is REDACTED_DATA) reads back with `redacted: true` and `data` equal to `{}`; every other field is kept. */
export function toStored(row: AuditRow): StoredAuditEvent {
  const type = text(row.subject_type);
  const id = text(row.subject_id);
  return {
    seq: Number(row.seq),
    redacted: row.data === REDACTED_DATA,
    id: text(row.id) ?? '',
    at: instantFromDb(row.at)?.toJSDate() ?? new Date(Number.NaN),
    kind: oneOf(AUDIT_KINDS, row.kind, 'custom'),
    action: text(row.action) ?? '',
    subject: type !== undefined && id !== undefined ? { type, id } : undefined,
    outcome: oneOf(AUDIT_OUTCOMES, row.outcome, 'ok'),
    actor: text(row.actor) ?? '',
    onBehalfOf: text(row.on_behalf_of),
    traceId: text(row.trace_id),
    origin: text(row.origin),
    tenant: text(row.tenant),
    decisionId: text(row.decision_id),
    idempotencyKey: text(row.idempotency_key),
    dataSubject: text(row.data_subject),
    data: payloadOf(row.data),
  };
}
