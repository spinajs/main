import { Injectable, Singleton } from '@spinajs/di';
import { DecisionAudit } from '../contracts/service.js';
import { engineLog } from './log.js';
import type { HostLog } from './log.js';

type AuditRecord = Parameters<DecisionAudit['record']>[0];

// The Log escapes and quotes each value, so user input in one cannot forge a field or a line.
const LINE =
  'authz audit ${kind} principal=${principalType}:${principalId}' +
  '${?permission} permission=${permission}${/permission}' +
  '${?resourceType} resource=${resourceType}${/resourceType}${?resourceId}:${resourceId}${/resourceId}' +
  '${?reason} reason=${reason}${/reason}${?command} command=${command}${/command}${?durationMs} durationMs=${durationMs}${/durationMs}';

function fields(e: AuditRecord): Record<string, unknown> {
  const cmd = e.command as { kind?: unknown } | null | undefined;
  return {
    kind: e.kind,
    principalType: e.principal.type,
    principalId: e.principal.id,
    permission: e.permission,
    resourceType: e.resource?.type,
    resourceId: e.resource?.id,
    reason: e.reason,
    command: e.kind === 'admin' && cmd !== null && typeof cmd === 'object' && typeof cmd.kind === 'string' ? cmd.kind : undefined,
    durationMs: e.trace?.durationMs,
  };
}

@Singleton()
@Injectable(DecisionAudit)
export class LogDecisionAudit extends DecisionAudit {
  private log: HostLog | undefined;

  /** `log` is for tests; DI constructs the class without arguments. */
  constructor(log?: HostLog) {
    super();
    this.log = log;
  }

  record(e: AuditRecord): void {
    try {
      const log = (this.log ??= engineLog('authz-audit'));
      const f = fields(e);
      if (e.kind === 'deny') log.warn(f, LINE);
      else log.info(f, LINE);
    } catch {
      // auditing never fails a check
    }
  }
}
