import { ChangeBus, DecisionAudit } from '@spinajs/authz';
import type { AuthzChange } from '@spinajs/authz';

export type AuditEntry = Parameters<DecisionAudit['record']>[0];

export class RecordingAudit extends DecisionAudit {
  readonly entries: AuditEntry[] = [];

  record(e: AuditEntry): void {
    this.entries.push(e);
  }

  of(kind: AuditEntry['kind']): AuditEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }
}

/** Fans out synchronously inside publish(), in subscription order; a throwing subscriber fails the publish. */
export class RecordingChangeBus extends ChangeBus {
  readonly published: AuthzChange[] = [];
  private readonly subscribers = new Set<(c: AuthzChange) => void>();

  publish(change: AuthzChange): Promise<void> {
    this.published.push(change);
    try {
      for (const fn of [...this.subscribers]) fn(change);
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve();
  }

  subscribe(fn: (c: AuthzChange) => void): () => void {
    const own = (c: AuthzChange) => fn(c);
    this.subscribers.add(own);
    return () => {
      this.subscribers.delete(own);
    };
  }
}

export class ManualClock {
  private ms: number;

  constructor(start: Date = new Date(0)) {
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): this {
    this.ms += ms;
    return this;
  }

  set(at: Date): this {
    this.ms = at.getTime();
    return this;
  }
}
