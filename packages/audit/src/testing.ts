import { Injectable } from '@spinajs/di';

import { AuditContext } from './context.js';
import { AuditReader, AuditStore } from './contracts.js';
import type { AuditAppend, AuditFilter, AuditSubject, StoredAuditEvent, TrailConfig } from './contracts.js';
import { isErasureRecord } from './erasure.js';

interface Row {
  readonly trail: string;
  event: StoredAuditEvent;
}

let rows: Row[] = [];
let appends: AuditAppend[] = [];
let seq = 0;
let failures = 0;
let joining = false;

const TESTS: readonly ((e: StoredAuditEvent, f: AuditFilter) => boolean)[] = [(e, f) => f.kinds === undefined || f.kinds.includes(e.kind), (e, f) => f.actions === undefined || f.actions.includes(e.action), (e, f) => f.subject === undefined || (e.subject?.type === f.subject.type && e.subject?.id === f.subject.id), (e, f) => f.subjectType === undefined || e.subject?.type === f.subjectType, (e, f) => f.actor === undefined || e.actor === f.actor, (e, f) => f.traceId === undefined || e.traceId === f.traceId, (e, f) => f.afterSeq === undefined || e.seq > f.afterSeq, (e, f) => f.from === undefined || e.at >= f.from, (e, f) => f.to === undefined || e.at <= f.to];

export class MemoryAuditReader extends AuditReader {
  list(trail: TrailConfig, filter: AuditFilter): Promise<readonly StoredAuditEvent[]> {
    const found = rows.filter((r) => r.trail === trail.name && TESTS.every((test) => test(r.event, filter))).map((r) => r.event);
    return Promise.resolve((filter.order === 'desc' ? found.reverse() : found).slice(0, filter.limit));
  }

  redact(trail: TrailConfig, subject: AuditSubject): Promise<number> {
    const hit = rows.filter((r) => r.trail === trail.name && r.event.subject?.type === subject.type && r.event.subject?.id === subject.id && !r.event.redacted && !isErasureRecord(r.event));
    for (const row of hit) row.event = { ...row.event, data: {}, redacted: true };
    return Promise.resolve(hit.length);
  }

  prune(trail: TrailConfig, before: Date): Promise<number> {
    const kept = rows.filter((r) => r.trail !== trail.name || r.event.at >= before);
    const deleted = rows.length - kept.length;
    rows = kept;
    return Promise.resolve(deleted);
  }
}

/**
 * Keeps events in memory, one sequence for every trail. For the tests of packages that record: import this module and
 * name `MemoryAuditStore` as a trail's store. The state is the module's, so a subclass registered under its own name
 * (to count or fail appends) shares it, and the statics below see what it stored.
 */
@Injectable(AuditStore)
export class MemoryAuditStore extends AuditStore {
  // It keeps the transaction it was handed for a test to assert on; nothing here commits or rolls back.
  override readonly joinsTransaction = true;

  /** Everything recorded, in order; with `trail`, only that trail's events. */
  static events(trail?: string): readonly StoredAuditEvent[] {
    return rows.filter((r) => trail === undefined || r.trail === trail).map((r) => r.event);
  }

  /** Every append that succeeded, with the transaction it was handed. */
  static appends(): readonly AuditAppend[] {
    return [...appends];
  }

  /** Makes the next `count` appends reject. */
  static failNext(count: number): void {
    failures = count;
  }

  /** Makes `joinsCaller` answer `join`, so confirmed writes are appended in the caller's async context. */
  static joinCaller(join = true): void {
    joining = join;
  }

  /** Forgets every event and append, restarts the sequence and drops the failures and the joining asked for. */
  static clear(): void {
    rows = [];
    appends = [];
    seq = 0;
    failures = 0;
    joining = false;
  }

  static reset(): void {
    MemoryAuditStore.clear();
  }

  append(write: AuditAppend): Promise<void> {
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(new Error('MemoryAuditStore: failing as asked'));
    }
    appends.push(write);
    for (const event of write.events) rows.push({ trail: write.trail.name, event: { ...event, seq: ++seq, redacted: false } });
    return Promise.resolve();
  }

  joinsCaller(): boolean {
    return joining;
  }

  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(new MemoryAuditReader());
  }
}

export interface TestIdentity {
  actor: string;
  onBehalfOf: string | undefined;
  traceId: string | undefined;
  origin: string | undefined;
}

const NOBODY: TestIdentity = { actor: 'system:test', onBehalfOf: undefined, traceId: undefined, origin: undefined };

/** An `AuditContext` that answers what a test assigned to `who`. Importing this module does not register it. */
export class TestAuditContext extends AuditContext {
  static readonly who: TestIdentity = { ...NOBODY };

  static reset(): void {
    Object.assign(TestAuditContext.who, NOBODY);
  }

  actor(): string {
    return TestAuditContext.who.actor;
  }

  onBehalfOf(): string | undefined {
    return TestAuditContext.who.onBehalfOf;
  }

  traceId(): string | undefined {
    return TestAuditContext.who.traceId;
  }

  origin(): string | undefined {
    return TestAuditContext.who.origin;
  }
}
