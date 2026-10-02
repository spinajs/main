import { Injectable, Singleton } from '@spinajs/di';
import { DecisionAudit } from '../contracts/service.js';
import { engineLog } from './log.js';
import type { HostLog } from './log.js';

type AuditRecord = Parameters<DecisionAudit['record']>[0];

// Values may carry user input: anything but a plain token is JSON-encoded so it cannot forge a field or a line.
const enc = (v: unknown): string => {
  const s = String(v);
  return /^[A-Za-z0-9_.:@/*-]+$/.test(s) ? s : JSON.stringify(s);
};

function format(e: AuditRecord): string {
  const parts = [`authz audit ${enc(e.kind)}`, `principal=${enc(e.principal.type)}:${enc(e.principal.id)}`];
  if (e.permission !== undefined) parts.push(`permission=${enc(e.permission)}`);
  if (e.resource !== undefined) parts.push(`resource=${enc(e.resource.type)}${e.resource.id === undefined ? '' : `:${enc(e.resource.id)}`}`);
  if (e.reason !== undefined) parts.push(`reason=${JSON.stringify(e.reason)}`);
  const cmd = e.command as { kind?: unknown } | null | undefined;
  if (e.kind === 'admin' && cmd !== null && typeof cmd === 'object' && typeof cmd.kind === 'string') parts.push(`command=${enc(cmd.kind)}`);
  if (e.trace !== undefined) parts.push(`durationMs=${e.trace.durationMs}`);
  return parts.join(' ');
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
      const line = format(e);
      if (e.kind === 'deny') log.warn(line);
      else log.info(line);
    } catch {
      // auditing never fails a check
    }
  }
}
