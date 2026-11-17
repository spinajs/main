import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Autoinject, Container, DI, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

import { auditContext } from './context.js';
import { AUDIT_KINDS, AUDIT_OUTCOMES, AUDIT_WIDTHS, AuditService } from './contracts.js';
import type { AuditEvent, AuditInput, AuditStore, AuditTrail, AuditWriteMode, AuditWriteOptions, TrailConfig } from './contracts.js';
import { AuditConfigError, AuditWriteFailed } from './errors.js';
import { quoted } from './guards.js';
import { canonicalJson } from './hash.js';
import { maskOf } from './mask.js';
import { auditStore } from './stores.js';
import { StoreAuditTrail } from './trail.js';
import { deferredConfig, trailConfig } from './trails.js';

// Confirmed and deferred writes run in this scope, outside the caller's async context. Joined to the caller's
// transaction they would roll back with it, and a flush timer would inherit the transaction of whoever buffered first.
const DETACHED = new AsyncResource('spinajs.audit');

interface Pending {
  readonly trail: TrailConfig;
  readonly store: AuditStore;
  readonly event: AuditEvent;
  readonly connection: string | undefined;
}

interface Way {
  readonly mode: AuditWriteMode;
  readonly onFailure: 'continue' | 'reject';
}

const isList = (input: AuditInput | readonly AuditInput[]): input is readonly AuditInput[] => Array.isArray(input);

function sized(name: string, value: string | undefined, max: number): void {
  if (value !== undefined && (value.length === 0 || value.length > max)) throw new AuditConfigError(`audit: ${name} must be 1 to ${max} characters`);
}

function check(input: AuditInput): void {
  if (!AUDIT_KINDS.includes(input.kind)) throw new AuditConfigError(`audit: unknown kind ${JSON.stringify(input.kind)}`);
  if (input.outcome !== undefined && !AUDIT_OUTCOMES.includes(input.outcome)) throw new AuditConfigError(`audit: unknown outcome ${JSON.stringify(input.outcome)}`);
  sized('action', input.action, AUDIT_WIDTHS.action);
  sized('subject.type', input.subject?.type, AUDIT_WIDTHS.subject_type);
  sized('subject.id', input.subject?.id, AUDIT_WIDTHS.subject_id);
  sized('dataSubject', input.dataSubject, AUDIT_WIDTHS.data_subject);
  try {
    canonicalJson(input.data);
  } catch (err) {
    throw new AuditConfigError('audit: data cannot be written as JSON', undefined, undefined, err);
  }
}

function wayOf(trail: TrailConfig, options: AuditWriteOptions): Way {
  const onFailure = options.onFailure ?? trail.onFailure;
  const mode = options.mode ?? (onFailure === 'reject' ? 'confirmed' : 'deferred');
  if (mode === 'transactional' && options.transaction === undefined) throw new AuditConfigError(`audit: a transactional write to trail ${quoted(trail.name)} needs options.transaction`);
  if (mode === 'deferred' && onFailure === 'reject') throw new AuditConfigError(`audit: a deferred write cannot reject, and trail ${quoted(trail.name)} is written with onFailure 'reject'; use mode 'confirmed'`);
  return { mode, onFailure };
}

function stamped(inputs: readonly AuditInput[], container: IContainer): AuditEvent[] {
  const ctx = auditContext(container);
  const W = AUDIT_WIDTHS;
  const who = {
    actor: ctx.actor().slice(0, W.actor),
    onBehalfOf: ctx.onBehalfOf()?.slice(0, W.on_behalf_of),
    traceId: ctx.traceId()?.slice(0, W.trace_id),
    origin: ctx.origin()?.slice(0, W.origin),
    tenant: ctx.tenant()?.slice(0, W.tenant),
    decisionId: ctx.decisionId()?.slice(0, W.decision_id),
    idempotencyKey: ctx.idempotencyKey()?.slice(0, W.idempotency_key),
  };
  const now = new Date();
  return inputs.map((input) => {
    check(input);
    return { id: randomUUID(), at: input.at ?? now, kind: input.kind, action: input.action, subject: input.subject, outcome: input.outcome ?? 'ok', ...who, dataSubject: input.dataSubject, data: input.data ?? {} };
  });
}

const LOST = 'audit: trail ${trail} lost ${count} event(s): ${ids}';
const UNCONFIRMED = 'audit: trail ${trail} gave up ${count} event(s) not confirmed in time; an append already under way may still store them: ${ids}';
const MISCONFIGURED = 'audit: trail ${trail} is misconfigured; dropped ${count} event(s): ${ids}';

const warn = (text: string): void => process.emitWarning(text, 'AuditWarning');
const errorText = (_key: string, value: unknown): unknown => (value instanceof Error ? value.message : value);

interface Deadline {
  readonly signal: AbortSignal;
  readonly expired: Promise<never>;
  clear(): void;
}

function deadline(ms: number): Deadline {
  const controller = new AbortController();
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new AuditWriteFailed(`audit: a deferred write did not finish within ${ms} ms`)), { once: true });
  });
  void expired.catch(() => undefined);
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, expired, clear: () => clearTimeout(timer) };
}

/** One per container: it reads `audit.*` and resolves its stores through the lineage of the container that resolved it. */
@PerChildInstance()
@Injectable(AuditService)
export class DefaultAuditService extends AuditService {
  @Autoinject(Container)
  protected Container!: IContainer;

  private readonly buffer: Pending[] = [];
  // Per trail and connection: an append given up on that may still store its batch.
  private readonly late = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private logger: Log | undefined;
  private overflowing = false;
  private disposed = false;

  async record(input: AuditInput | readonly AuditInput[], options: AuditWriteOptions = {}): Promise<void> {
    const trail = trailConfig(options.trail, this.Container);
    const { mode, onFailure } = wayOf(trail, options);
    const store = await auditStore(trail, this.Container);
    if (mode === 'transactional' && store.joinsTransaction !== true) {
      throw new AuditConfigError(`audit: a transactional write to trail ${quoted(trail.name)} needs a store that joins the caller's transaction, and ${store.constructor.name} does not`);
    }

    const events = stamped(isList(input) ? input : [input], this.Container).map(maskOf(trail, options, this.Container));
    if (events.length === 0) return;
    if (mode === 'transactional') return this.joined(store, trail, events, options.transaction);
    if (mode === 'deferred') return this.defer(trail, store, events, options.connection);
    await this.confirm(store, trail, events, onFailure, options.connection);
  }

  trail(name?: string): AuditTrail {
    return new StoreAuditTrail(this, trailConfig(name, this.Container), this.Container);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.draining ??= DETACHED.runInAsyncScope(() => this.drain());
    return this.draining;
  }

  public override async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush();
    await super.dispose();
  }

  // Never retried: a second statement in a failed transaction cannot succeed on Postgres. Always rejects: the audited write must fail with its record.
  private async joined(store: AuditStore, trail: TrailConfig, events: readonly AuditEvent[], transaction: unknown): Promise<void> {
    try {
      await store.append({ trail, events, transaction });
    } catch (err) {
      if (err instanceof AuditWriteFailed || err instanceof AuditConfigError) throw err;
      throw new AuditWriteFailed(`audit: trail ${quoted(trail.name)} could not record ${events.length} event(s) in the transaction of the audited write`, err);
    }
  }

  private defer(trail: TrailConfig, store: AuditStore, events: readonly AuditEvent[], connection: string | undefined): Promise<void> {
    const { flushMs, maxBuffered } = deferredConfig(this.Container);
    const accepted = events.slice(0, Math.max(0, maxBuffered - this.buffer.length));
    if (accepted.length < events.length && !this.overflowing) {
      this.report('warn', { trail: trail.name, dropped: events.length - accepted.length }, 'audit: the deferred buffer is full; dropped ${dropped} event(s) of trail ${trail}');
    }
    this.overflowing = accepted.length < events.length || this.overflowing;
    for (const event of accepted) this.buffer.push({ trail, store, event, connection });
    // No timer may outlive the service: once disposed, an event is written before record() returns.
    if (this.disposed) return this.flush();
    this.timer ??= DETACHED.runInAsyncScope(() => setTimeout(() => void this.flush().catch((err: unknown) => warn(`audit: a background flush failed: ${String(err)}`)), flushMs).unref());
    return Promise.resolve();
  }

  private async drain(): Promise<void> {
    // Yields first: without it an empty buffer would clear `draining` before flush() has assigned it.
    await Promise.resolve();
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, deferredConfig(this.Container).maxBatch);
        this.overflowing = false;
        await this.write(batch);
      }
    } finally {
      this.draining = undefined;
    }
  }

  private async write(batch: readonly Pending[]): Promise<void> {
    const byTarget = new Map<string, Pending[]>();
    for (const pending of batch) {
      // A trail name holds no space, so the key cannot mix two trails or two connections.
      const key = `${pending.trail.name} ${pending.connection ?? ''}`;
      const group = byTarget.get(key);
      if (group) group.push(pending);
      else byTarget.set(key, [pending]);
    }
    for (const [key, group] of byTarget) await this.send(key, group);
  }

  // The deadline stops the retries of a batch it gave up on. The append under way cannot be recalled, so the next
  // append to the same target first waits for it, within its own deadline: a call split at maxBatch keeps its order.
  private async send(key: string, group: readonly Pending[]): Promise<void> {
    const { trail, store, connection } = group[0];
    const events = group.map((p) => p.event);
    const limit = deadline(deferredConfig(this.Container).timeoutMs);
    let work: Promise<void> | undefined;
    try {
      await Promise.race([this.late.get(key), limit.expired]);
      work = this.attempt(store, trail, events, connection, limit.signal);
      await Promise.race([work, limit.expired]);
    } catch (err) {
      if (work !== undefined && limit.signal.aborted) this.wait(key, work);
      this.lost(trail, events, err, limit.signal.aborted ? UNCONFIRMED : LOST);
    } finally {
      limit.clear();
    }
  }

  private wait(key: string, work: Promise<void>): void {
    const settled: Promise<void> = work
      .catch(() => undefined)
      .finally(() => {
        if (this.late.get(key) === settled) this.late.delete(key);
      });
    this.late.set(key, settled);
  }

  private async confirm(store: AuditStore, trail: TrailConfig, events: readonly AuditEvent[], onFailure: 'continue' | 'reject', connection: string | undefined): Promise<void> {
    try {
      await DETACHED.runInAsyncScope(() => this.attempt(store, trail, events, connection));
    } catch (err) {
      if (err instanceof AuditConfigError) throw err;
      if (onFailure === 'continue') return this.lost(trail, events, err);
      throw new AuditWriteFailed(`audit: trail ${quoted(trail.name)} could not record ${events.length} event(s) after ${trail.retry.attempts} attempt(s)`, err);
    }
  }

  // `retry.attempts` counts every try, the first included. A configuration error would fail every try alike.
  private async attempt(store: AuditStore, trail: TrailConfig, events: readonly AuditEvent[], connection: string | undefined, signal?: AbortSignal): Promise<void> {
    for (let tries = 1; ; tries++) {
      try {
        return await store.append({ trail, events, connection });
      } catch (err) {
        if (err instanceof AuditConfigError || tries >= trail.retry.attempts || signal?.aborted === true) throw err;
        await sleep(trail.retry.delayMs, undefined, { signal });
      }
    }
  }

  private lost(trail: TrailConfig, events: readonly AuditEvent[], err: unknown, message = LOST): void {
    const ids = events
      .slice(0, 20)
      .map((e) => e.id)
      .join(',');
    this.report('error', { error: err, trail: trail.name, count: events.length, ids }, err instanceof AuditConfigError ? MISCONFIGURED : message);
  }

  // A log line must not change the outcome of a write: without a working logger the line becomes a process warning.
  private report(level: 'warn' | 'error', fields: Record<string, unknown>, message: string): void {
    try {
      if (level === 'warn') this.log().warn(fields, message);
      else this.log().error(fields, message);
    } catch (err) {
      warn(`audit: the logger "audit-pipeline" failed (${String(err)}): ${message} ${JSON.stringify(fields, errorText)}`);
    }
  }

  private log(): Log {
    return (this.logger ??= this.Container.resolve(Log, ['audit-pipeline']));
  }
}

/** The audit service of `container`: one per container (see DefaultAuditService). */
export function audit(container: IContainer = DI.RootContainer): AuditService {
  return container.resolve(AuditService);
}
