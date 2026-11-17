import { AuthzConfigError, DecisionLog, SYSTEM, engineLog, parseResourceKey, resourceKey, runWithPrincipal, thrownError } from '@spinajs/authz';
import type { AuthzLog, DecisionRecord } from '@spinajs/authz';
import { Singleton } from '@spinajs/di';
import { DateTime } from 'luxon';

import { AuthzDecisionLogEntry, DECISION_LOG_TABLE } from './decision-log-model.js';

// A value longer than its column fails the whole insert on some databases, and the batch would be lost.
const fit = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
};

const WIDTHS = { principal: 100, actor: 100, resource: 255 } as const;

const json = (v: unknown): string | null => {
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
};

/**
 * Writes each batch of decision records to `authz_decision_log` (migration `AuthzDecisionLog_2026_11_04_00_00_00`) in one
 * insert, on the `authz-audit` connection. Append-only: nothing here updates or deletes a row. Not registered by importing
 * it: the app registers it as the `DecisionLog`. A failed batch is logged and dropped; `write` never rejects.
 */
@Singleton()
export class DbDecisionLog extends DecisionLog {
  private log: Pick<AuthzLog, 'error'> | undefined;

  /** `log` is for tests; DI constructs the class without arguments. */
  constructor(log?: Pick<AuthzLog, 'error'>) {
    super();
    this.log = log;
  }

  async write(records: DecisionRecord[]): Promise<void> {
    if (records.length === 0) return;
    try {
      const rows = records.map(rowOf);
      // As SYSTEM: an app that scopes this model must not scope (or audit) the log's own write.
      await runWithPrincipal(SYSTEM, async () => {
        await AuthzDecisionLogEntry.insert(rows);
      });
    } catch (e) {
      (this.log ??= engineLog('authz-decision-log')).error({ error: thrownError(e), count: records.length, table: DECISION_LOG_TABLE }, 'authz decision log: writing ${count} record(s) to ${table} failed, they are dropped');
    }
  }
}

function rowOf(r: DecisionRecord): Partial<AuthzDecisionLogEntry> {
  const row: Partial<AuthzDecisionLogEntry> = {
    id: r.id,
    at: DateTime.fromISO(r.at, { zone: 'utc' }),
    trace_id: r.traceId ?? null,
    span_id: r.spanId ?? null,
    domain: fit(r.domain, 64),
    principal: fit(r.principal, WIDTHS.principal),
    actor: r.actor === undefined ? null : fit(r.actor, WIDTHS.actor),
    permission: fit(r.permission, 160),
    resource: fit(resourceKey(r.resource), WIDTHS.resource),
    allowed: r.allowed,
    reason: r.reason === undefined ? null : fit(r.reason, 255),
    cached: r.cached,
    policy_hash: fit(r.policyHash, 128),
    model_versions: json(r.modelVersions),
    inputs_hash: r.inputsHash,
    inputs: r.inputs === undefined ? null : json(r.inputs),
    facts: r.facts === undefined ? null : json(r.facts),
    // An integer column: rounded up, so the window it widens never shrinks.
    duration_ms: r.durationMs === undefined ? null : Math.ceil(r.durationMs),
  };
  if (r.loggedAt !== undefined) row.logged_at = DateTime.fromISO(r.loggedAt, { zone: 'utc' });
  return row;
}

type Truncated = 'principal' | 'actor' | 'resource';

const flag = (v: unknown): boolean => v === true || v === 1;

function parsed(row: AuthzDecisionLogEntry, column: 'model_versions' | 'inputs' | 'facts'): unknown {
  const text = row[column];
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new AuthzConfigError(`${DECISION_LOG_TABLE} row ${row.id}: ${column} is not JSON`, { cause: err });
  }
}

function recordOf(row: AuthzDecisionLogEntry): DecisionRecord {
  const record: DecisionRecord = {
    id: row.id,
    at: row.at.toJSDate().toISOString(),
    domain: row.domain,
    principal: row.principal,
    permission: row.permission,
    resource: parseResourceKey(row.resource),
    allowed: flag(row.allowed),
    cached: flag(row.cached),
    policyHash: row.policy_hash,
    modelVersions: (parsed(row, 'model_versions') as Record<string, string> | undefined) ?? {},
    inputsHash: row.inputs_hash,
  };
  const optional: Partial<DecisionRecord> = {
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    actor: row.actor ?? undefined,
    reason: row.reason ?? undefined,
    inputs: parsed(row, 'inputs') as DecisionRecord['inputs'],
    facts: parsed(row, 'facts') as DecisionRecord['facts'],
    loggedAt: row.logged_at?.isValid ? row.logged_at.toJSDate().toISOString() : undefined,
    durationMs: row.duration_ms ?? undefined,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) Object.assign(record, { [k]: v });
  return record;
}

const truncatedOf = (row: AuthzDecisionLogEntry): Truncated[] => (['principal', 'actor', 'resource'] as const).filter((k) => Array.from(row[k] ?? '').length >= WIDTHS[k]);

/**
 * The decision record logged under `id`, read from the primary; `truncated` names the keys the log cut to their column
 * width, which no longer name what the decision named. Undefined when no record has that id.
 */
export async function readDecisionRecord(id: string): Promise<{ record: DecisionRecord; truncated: Truncated[] } | undefined> {
  if (typeof id !== 'string') throw new AuthzConfigError('readDecisionRecord: the id must be a string');
  // As SYSTEM, like the write: an app that scopes this model must not scope the log's own read.
  const row = await runWithPrincipal(SYSTEM, async () => (await AuthzDecisionLogEntry.query().onPrimary().where('id', id).first()) as AuthzDecisionLogEntry | undefined);
  return row === undefined ? undefined : { record: recordOf(row), truncated: truncatedOf(row) };
}
