import { SyncService } from '@spinajs/di';

export type AuditKind = 'data' | 'read' | 'action' | 'security' | 'custom';
export type AuditOutcome = 'ok' | 'denied' | 'failed' | 'attempt';
export const AUDIT_KINDS: readonly AuditKind[] = ['data', 'read', 'action', 'security', 'custom'];
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['ok', 'denied', 'failed', 'attempt'];

/** Widths of the trail table columns. The core refuses or cuts values to them, so an event is valid for every store or for none. */
export const AUDIT_WIDTHS = Object.freeze({ id: 36, kind: 16, action: 128, subject_type: 128, subject_id: 255, outcome: 16, actor: 100, on_behalf_of: 100, trace_id: 32, origin: 64, tenant: 64, decision_id: 36, idempotency_key: 128, data_subject: 255, data_hash: 64 });

export interface AuditSubject {
  readonly type: string;
  readonly id: string;
}

export interface AuditEvent {
  /** Stable id (UUID); what sinks deduplicate on. */
  readonly id: string;
  readonly at: Date;
  readonly kind: AuditKind;
  /** What happened: 'update', 'invoice.export', 'patient.read', 'login'. */
  readonly action: string;
  /** What it happened to; absent for an action with no single target. */
  readonly subject?: AuditSubject;
  readonly outcome: AuditOutcome;
  /** principalKey of the effective principal. */
  readonly actor: string;
  /** principalKey of the person acting through the actor, when impersonating. */
  readonly onBehalfOf?: string;
  readonly traceId?: string;
  /** Client address, when the event comes from a request. */
  readonly origin?: string;
  readonly tenant?: string;
  readonly decisionId?: string;
  readonly idempotencyKey?: string;
  /** The person a record is about, as opposed to the row it is. */
  readonly dataSubject?: string;
  /** Kind-specific payload, after omit, mask and hash. */
  readonly data: Readonly<Record<string, unknown>>;
}

/** What a producer passes; the service stamps the rest. */
export interface AuditInput {
  readonly kind: AuditKind;
  readonly action: string;
  readonly subject?: AuditSubject;
  /** Default 'ok'. */
  readonly outcome?: AuditOutcome;
  readonly dataSubject?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly at?: Date;
}

export type AuditWriteMode = 'transactional' | 'confirmed' | 'deferred';

export interface AuditWriteOptions {
  /** Default 'default'. */
  readonly trail?: string;
  /** Default: 'confirmed' when the effective onFailure is 'reject', else 'deferred'. */
  readonly mode?: AuditWriteMode;
  /** Overrides the trail's. */
  readonly onFailure?: 'continue' | 'reject';
  /** 'transactional' only: the connection whose open transaction the events join. Opaque here; `@spinajs/audit-orm` passes an OrmDriver. */
  readonly transaction?: unknown;
  /** 'confirmed' and 'deferred' only: the connection the events are written on, default the trail's. A store that keeps no connections ignores it. */
  readonly connection?: string;
  readonly omit?: readonly string[];
  readonly mask?: readonly string[];
  readonly hash?: readonly string[];
}

export interface TrailConfig {
  readonly name: string;
  readonly store: string;
  readonly table: string;
  readonly connection: string;
  readonly onFailure: 'continue' | 'reject';
  readonly retry: { readonly attempts: number; readonly delayMs: number };
  readonly integrity: 'none' | 'sealed';
  readonly omit: readonly string[];
  readonly mask: readonly string[];
  readonly hash: readonly string[];
  readonly retentionDays: number | undefined;
  readonly sink: string | undefined;
  readonly reader: string | undefined;
  /** The connection that holds the archive of a shipping trail. */
  readonly archiveConnection: string | undefined;
}

export interface AuditAppend {
  readonly trail: TrailConfig;
  readonly events: readonly AuditEvent[];
  readonly transaction?: unknown;
  /** Without a transaction: the connection the write named; undefined means the trail's. */
  readonly connection?: string;
}

export abstract class AuditStore {
  /** True when an append that is handed a transaction commits and rolls back with it; a transactional write is refused on a store without it. */
  readonly joinsTransaction?: boolean;
  /**
   * Asked synchronously in the caller's async context before a confirmed write; true appends there instead of detached,
   * once, without retries and without `audit.confirmTimeoutMs`. The cost of joining: the record then commits or rolls back
   * with the caller's open transaction. A store answering true must leave that transaction usable when its append fails
   * (a savepoint where the driver aborts a transaction on error, as Postgres does), or answer false there. Throwing an
   * `AuditConfigError` fails the write; any other throw reads as false.
   */
  joinsCaller?(trail: TrailConfig, connection: string | undefined): boolean;
  /** Throwing fails the write; the service applies retry and onFailure around it. */
  abstract append(write: AuditAppend): Promise<void>;
  /** Undefined: the trail cannot be read from this application. */
  abstract reader(trail: TrailConfig): Promise<AuditReader | undefined>;
}

export interface StoredAuditEvent extends AuditEvent {
  readonly seq: number;
  readonly redacted: boolean;
}

export interface AuditFilter {
  /** Connection of the audited writes; default the trail's connection. */
  readonly source?: string;
  readonly kinds?: readonly AuditKind[];
  readonly actions?: readonly string[];
  readonly subject?: AuditSubject;
  readonly subjectType?: string;
  readonly actor?: string;
  readonly traceId?: string;
  readonly afterSeq?: number;
  readonly from?: Date;
  readonly to?: Date;
  readonly order: 'asc' | 'desc';
  readonly limit: number;
}

export interface AuditTamper {
  /** The event whose payload no longer matches its data_hash; for every other reason the first seq of the seal's range. */
  readonly seq: number;
  /**
   * payload: an event's payload was changed. seal: a sealed field or a hash was changed. count: a sealed event is gone
   * (deleted, or its seal marked pruned out of chain order or in the future), or a row stamped after the seal was written into its
   * range. chain: a seal is gone or was replaced.
   */
  readonly reason: 'payload' | 'seal' | 'count' | 'chain';
  readonly fromSeq: number;
  readonly toSeq: number;
}

/** A row inside a sealed range that its seal does not cover; its own content is protected by no seal. */
export interface AuditUncoveredRow {
  readonly seq: number;
  /**
   * late: committed after its range was sealed (a transaction that outlived audit.seal.settleSeconds), or inserted into
   * the range later with an earlier `at`: the two look alike. One such row per seal is always recognised, two or more only
   * in small seals; otherwise the seal is reported as `count`. pruned: present in a range retention removed, written after
   * it or after a seq reset.
   */
  readonly reason: 'late' | 'pruned';
  readonly fromSeq: number;
  readonly toSeq: number;
}

/** A seal's end and hash kept outside the database, for example from the sealer's log; it protects the chain up to its `toSeq` only. */
export interface AuditPinnedHead {
  readonly toSeq: number;
  readonly hash: string;
}

export interface AuditVerifyReport {
  readonly trail: string;
  /** The connection and table whose seals were recomputed. */
  readonly connection: string;
  readonly table: string;
  /** Seals examined, the failing one included. */
  readonly seals: number;
  /** Sealed events whose payload matches, in seals that match. */
  readonly intact: number;
  /** Sealed events whose payload was erased: the hash was kept, so their seal still matches. */
  readonly redacted: number;
  /** Seals whose events retention removed; only their link in the chain is checked. */
  readonly prunedSeals: number;
  /** The first mismatch, where verification stopped; undefined when every seal matches. */
  readonly tampered: AuditTamper | undefined;
  /** Events after the last seal, not covered yet. */
  readonly unsealed: number;
  /** Of those, events older than the sealing window: a sealer that stopped, a backlog, or deleted seals. */
  readonly staleUnsealed: number;
  /** The last seal that verified; a copy of its hash kept outside the database pins the chain. */
  readonly head: { readonly toSeq: number; readonly hash: string } | undefined;
  /** Rows in sealed ranges that their seal does not cover, up to where verification stopped; not tampering by themselves. */
  readonly uncovered: readonly AuditUncoveredRow[];
  /** Seqs of sealed events whose payload is erased with no `erasure` record of their subject at or after them: blanked outside `forget`. */
  readonly unexplainedRedactions: readonly number[];
  /**
   * Seals marked pruned that the trail's retention here does not explain (younger than retentionDays when pruned, or no
   * retentionDays): lawful after a retention change or a direct prune, else events deleted under a forged prune.
   */
  readonly earlyPrunes: readonly { readonly fromSeq: number; readonly toSeq: number }[];
}

/** What an erasure blanked on one connection, where `forget` records its `erasure` event; `connection` undefined is the trail's own. */
export interface AuditRedaction {
  readonly connection: string | undefined;
  readonly redacted: number;
}

export abstract class AuditReader {
  abstract list(trail: TrailConfig, filter: AuditFilter): Promise<readonly StoredAuditEvent[]>;
  /** Blanks the payload of every event of one subject, erasure records (`custom`/`erasure`) excepted, and keeps its hash; returns how many. */
  abstract redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number>;
  /**
   * The erasure `forget` runs, one connection at a time: `forget` records each yielded redaction's `erasure` event,
   * beside the payloads it explains where `verify` looks for it, before the next connection is blanked. By default
   * `redact` on `source`, recorded there.
   */
  async *redactEach(trail: TrailConfig, subject: AuditSubject, source?: string): AsyncGenerator<AuditRedaction> {
    yield { connection: source, redacted: await this.redact(trail, subject, source) };
  }
  abstract prune(trail: TrailConfig, before: Date, source?: string): Promise<number>;
  /** Optional: recomputes the seals of the trail's table; a pinned head must be met on the chain. A reader that cannot leaves it out. */
  verify?(trail: TrailConfig, source?: string, pinned?: AuditPinnedHead): Promise<AuditVerifyReport>;
}

export interface AuditBatch {
  readonly trail: string;
  readonly source: string;
  readonly events: readonly AuditEvent[];
}

export abstract class AuditEventSink {
  /** Returns once the events are durable at the destination; may be called again with the same events (deduplicate on event.id). */
  abstract deliver(batch: AuditBatch): Promise<void>;
}

export interface AuditQuery {
  readonly afterSeq?: number;
  /** Default 100, at most 1000. */
  readonly limit?: number;
  readonly kinds?: readonly AuditKind[];
  readonly actions?: readonly string[];
  /** Only events about subjects of this type. */
  readonly subjectType?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly source?: string;
  /** By seq; default 'asc'. */
  readonly order?: 'asc' | 'desc';
}

export interface AuditTrail {
  readonly config: TrailConfig;
  byActor(actor: string, query?: AuditQuery): Promise<readonly StoredAuditEvent[]>;
  of(subject: AuditSubject, query?: AuditQuery): Promise<readonly StoredAuditEvent[]>;
  byTrace(traceId: string, query?: AuditQuery): Promise<readonly StoredAuditEvent[]>;
  since(seq: number, query?: AuditQuery): Promise<readonly StoredAuditEvent[]>;
  /** Redacts one subject and records an 'erasure' event beside what it redacted (`AuditReader.redactEach`); returns how many events it blanked. */
  forget(subject: AuditSubject, source?: string): Promise<number>;
  /** Recomputes the seals of a sealed trail; throws AuditNotSupported when the trail is not sealed, has no reader, or its reader cannot verify. */
  verify(source?: string, pinned?: AuditPinnedHead): Promise<AuditVerifyReport>;
}

/** A Service, so that disposing the container writes out the deferred buffer. */
export abstract class AuditService extends SyncService {
  abstract record(input: AuditInput | readonly AuditInput[], options?: AuditWriteOptions): Promise<void>;
  abstract trail(name?: string): AuditTrail;
  /** Writes out the deferred buffer. */
  abstract flush(): Promise<void>;
}
