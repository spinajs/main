import { DecisionAudit, SYSTEM, engineLog, resourceKey, runWithPrincipal } from '@spinajs/authz';
import type { HostLog } from '@spinajs/authz';
import { Singleton } from '@spinajs/di';
import { DateTime } from 'luxon';

import { AUDIT_TABLE, AuthzAuditEntry } from './model.js';

type AuditRecord = Parameters<DecisionAudit['record']>[0];

// Postgres refuses a value longer than its varchar column, which would lose the whole row.
const fit = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
};

const optional = (v: unknown, max: number): string | null => (v === undefined || v === null ? null : fit(String(v), max));

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Writes one `authz_audit` row per record (migration `AuthzAudit_2026_10_01_00_00_00`) through the
 * `AuthzAuditEntry` model, on the connection named `authz-audit`. Not registered by importing it:
 * the app registers it as the `DecisionAudit` (README, "Database audit"). A failed write is logged
 * and the record dropped; `record` never rejects, so auditing never fails a check.
 */
@Singleton()
export class DbDecisionAudit extends DecisionAudit {
  private log: HostLog | undefined;

  /** `log` is for tests; DI constructs the class without arguments. */
  constructor(log?: HostLog) {
    super();
    this.log = log;
  }

  record(e: AuditRecord): Promise<void> {
    return this.write(e).catch((err: unknown) => this.logger().error(`authz audit: writing a ${String(e?.kind)} entry to ${AUDIT_TABLE} failed, the entry is dropped: ${describeError(err)}`));
  }

  private logger(): HostLog {
    return (this.log ??= engineLog('authz-audit'));
  }

  private async write(e: AuditRecord): Promise<void> {
    const entry = new AuthzAuditEntry({
      at: DateTime.utc(),
      kind: fit(String(e.kind), 16),
      principal: fit(resourceKey({ type: e.principal.type, id: e.principal.id }), 100),
      permission: optional(e.permission, 160),
      resource: e.resource === undefined || e.resource === null ? null : fit(resourceKey(e.resource), 255),
      reason: optional(e.reason, 255),
      trace: this.traceOf(e),
    });
    // As SYSTEM: an app that scopes the audit model must not scope (or audit) the audit's own write.
    await runWithPrincipal(SYSTEM, () => entry.insert());
  }

  // An admin record has no trace; its command (secrets already removed by AuthzAdmin) goes there.
  private traceOf(e: AuditRecord): string | null {
    const value = e.trace ?? (e.kind === 'admin' ? e.command : undefined);
    if (value === undefined) return null;
    try {
      return JSON.stringify(value) ?? null;
    } catch (err) {
      this.logger().warn(`authz audit: the trace of a ${String(e.kind)} entry is not JSON, stored without it: ${describeError(err)}`);
      return null;
    }
  }
}
