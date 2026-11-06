import { DecisionLog, SYSTEM, engineLog, resourceKey, runWithPrincipal, thrownError } from '@spinajs/authz';
import type { AuthzLog, DecisionRecord } from '@spinajs/authz';
import { Singleton } from '@spinajs/di';
import { DateTime } from 'luxon';

import { AuthzDecisionLogEntry, DECISION_LOG_TABLE } from './decision-log-model.js';

// A value longer than its column fails the whole insert on some databases, and the batch would be lost.
const fit = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
};

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
  return {
    id: r.id,
    at: DateTime.fromISO(r.at, { zone: 'utc' }),
    trace_id: r.traceId ?? null,
    span_id: r.spanId ?? null,
    domain: fit(r.domain, 64),
    principal: fit(r.principal, 100),
    actor: r.actor === undefined ? null : fit(r.actor, 100),
    permission: fit(r.permission, 160),
    resource: fit(resourceKey(r.resource), 255),
    allowed: r.allowed,
    reason: r.reason === undefined ? null : fit(r.reason, 255),
    cached: r.cached,
    policy_hash: fit(r.policyHash, 128),
    model_versions: json(r.modelVersions),
    inputs_hash: r.inputsHash,
    inputs: r.inputs === undefined ? null : json(r.inputs),
  };
}
