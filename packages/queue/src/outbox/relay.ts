import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Config } from '@spinajs/configuration';
import { AsyncService, Autoinject, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import type { IInstanceCheck } from '@spinajs/di';
import { Clock, computeBackoff, DbClock, FaultInjector, parseDuration, type NormalizedRetry, type TimerHandle } from '@spinajs/durable';
import { Log, Logger } from '@spinajs/log';
import { Orm } from '@spinajs/orm';
import { isCrash } from '../crash.js';
import { QueueService } from '../interfaces.js';
import { outboxConfig, outboxRetry, type IQueueOutboxConfig } from './config.js';
import { inRootContext } from './root-context.js';
import { hydrateOutboxMessage } from './row.js';
import { OutboxStore, type OutboxClaim } from './store.js';
import { outboxTargets } from './targets.js';

export interface OutboxRelayOptions {
  replicaId?: string;
  /** false: never start the timer loop; the caller drives tick() (tests, the simulation). */
  autoStart?: boolean;
  /** Backoff jitter; the simulation passes its seeded stream. */
  random?: () => number;
}

let processRelayId: string | undefined;
const defaultRelayId = (): string => (processRelayId ??= `${hostname().slice(0, 40)}:${process.pid}:${randomBytes(3).toString('hex')}`);

/** DI hands `__checkInstance__` the creation options as `unknown[]`. */
function replicaIdOf(options: unknown): string | undefined {
  return typeof options === 'object' && options !== null && 'replicaId' in options && typeof options.replicaId === 'string' ? options.replicaId : undefined;
}

/** Claims due outbox rows, publishes each through QueueService.publishDirect and marks it, fenced by its claim. */
@PerInstanceCheck()
@Injectable()
export class OutboxRelay extends AsyncService implements IInstanceCheck {
  @Logger('queue')
  protected Log: Log;

  @Config('queue.outbox')
  protected Raw: Partial<IQueueOutboxConfig> | undefined;

  @Autoinject(Clock)
  protected Timers: Clock;

  @Autoinject(DbClock)
  protected Time: DbClock;

  @Autoinject(FaultInjector)
  protected Faults: FaultInjector;

  public readonly replicaId: string;
  protected config: IQueueOutboxConfig;
  protected retry: NormalizedRetry;
  protected maxAgeMs: number;
  protected retentionMs: number;
  protected lastPurge = new Map<string, number>();
  protected stores = new Map<string, OutboxStore>();
  protected ticking?: Promise<void>;
  protected queue?: QueueService;
  protected running = false;
  protected timer?: TimerHandle;
  /** A commit nudged while a pass was in flight; that pass may have read its due rows before the commit. */
  protected again = false;
  /** stop() came during the pass in flight, which then releases the rows it has not published yet. */
  protected halting = false;

  constructor(public readonly Options: OutboxRelayOptions = {}) {
    super();
    this.replicaId = Options.replicaId ?? defaultRelayId();
  }

  public __checkInstance__(creationOptions: unknown[] | undefined): boolean {
    return (replicaIdOf(creationOptions?.[0]) ?? defaultRelayId()) === this.replicaId;
  }

  public async resolve(): Promise<void> {
    this.config = outboxConfig(this.Raw);
    this.retry = outboxRetry(this.config);
    this.maxAgeMs = parseDuration(this.config.maxAge, 'queue.outbox.maxAge');
    this.retentionMs = parseDuration(this.config.retention, 'queue.outbox.retention');
    for (const t of outboxTargets(await DI.resolve(Orm), this.config.connections)) this.stores.set(t.connection, new OutboxStore(t.driver));
    await this.Time.sync();
    await super.resolve();
    if (this.config.relay && this.Options.autoStart !== false) this.start();
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.halting = false;
    this.schedule(0);
  }

  /** Waits for the pass in flight, but not past claimTtl: by then another relay may take its rows over anyway. */
  public async stop(): Promise<void> {
    this.running = false;
    this.again = false;
    if (this.timer !== undefined) this.Timers.clearTimeout(this.timer);
    this.timer = undefined;
    const pass = this.ticking;
    if (!pass) return;
    this.halting = true;
    const bound = new AbortController();
    await Promise.race([pass.catch(() => undefined), this.Timers.sleep(this.config.claimTtl, bound.signal)]);
    bound.abort();
  }

  /** While the loop runs: a pass at once, or one more right after the pass in flight. Otherwise the next tick() drains. */
  public nudge(connection: string): void {
    if (!this.running) return;
    this.Log.trace({ connection }, 'Outbox relay nudged by a commit on ${connection}');
    if (this.ticking) {
      // a timer armed now would only join the pass in flight
      this.again = true;
      return;
    }
    this.schedule(0);
  }

  /** The pass in progress, if any. */
  public drained(): Promise<void> {
    return this.ticking ?? Promise.resolve();
  }

  public async dispose(): Promise<void> {
    await this.stop();
    await super.dispose();
  }

  /** One pass over every outbox connection. Concurrent callers share the pass in progress. */
  public tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = undefined;
      this.halting = false;
    });
    return this.ticking;
  }

  protected schedule(ms: number): void {
    if (this.timer !== undefined) this.Timers.clearTimeout(this.timer);
    this.timer = this.Timers.setTimeout(() => inRootContext(() => void this.loop()), ms);
  }

  /** A crash stops the loop for good: the process it stands for is dead. Any other failure is logged and the loop goes on. */
  protected async loop(): Promise<void> {
    this.timer = undefined;
    try {
      await this.tick();
    } catch (error) {
      if (isCrash(error)) {
        this.running = false;
        return;
      }
      this.Log.error({ error, replicaId: this.replicaId }, 'Outbox relay ${replicaId} tick failed');
    }
    if (!this.running) return;
    // read once the pass has ended, and schedule(0) replaces any armed timer: however many commits nudged, one pass follows
    if (this.again) {
      this.again = false;
      this.schedule(0);
    } else if (this.timer === undefined) {
      this.schedule(this.config.tick);
    }
  }

  protected async pass(): Promise<void> {
    await this.Time.sync();
    for (const [connection, store] of this.stores) {
      if (this.halting) return;
      await this.drain(connection, store);
      await this.purgeIfDue(connection, store);
    }
  }

  // Claims, publishes, marks and releases run one statement at a time: the caller may hand this pass a transaction
  // context, and statements of one transaction must not run in parallel.
  protected async drain(connection: string, store: OutboxStore): Promise<void> {
    const claims: OutboxClaim[] = [];
    for (const row of await store.due(this.Time.now(), this.config.batchSize)) {
      // each claim from its own time: the time spent reading and claiming the batch must not shorten it
      const claim = await store.claim(row, this.replicaId, this.config.claimTtl, this.Time.now());
      if (claim) claims.push(claim);
    }

    // Claims later in the batch end later, so a row its claim can no longer cover is released and the batch goes on:
    // stopping there would release rows that still have time, and on a slow database every pass would publish nothing
    for (const claim of claims) {
      if (!this.halting && this.Time.now() + this.config.maxPublishMs <= claim.until) {
        await this.publishRow(connection, store, claim);
      } else if (!(await store.release(claim))) {
        this.Log.warn({ messageId: claim.row.MessageId, connection }, 'Outbox row ${messageId} on ${connection} was claimed by another relay before this one reached it');
      }
    }
  }

  protected async publishRow(connection: string, store: OutboxStore, claim: OutboxClaim): Promise<void> {
    const { row } = claim;
    const published = [...row.PublishedTo];
    try {
      await (await this.queueService()).publishDirect(hydrateOutboxMessage(row.Message), { skip: row.PublishedTo, published });
    } catch (error) {
      if (isCrash(error)) throw error;
      await this.fail(store, claim, published, error);
      return;
    }

    await this.Faults.point('outbox.after-publish', { messageId: row.MessageId, connection });
    await this.Faults.point('outbox.before-mark', { messageId: row.MessageId, connection });
    if (!(await store.markPublished(claim, published, this.Time.now()))) {
      this.Log.warn({ messageId: row.MessageId, connection }, 'Outbox row ${messageId} on ${connection} lost its claim while publishing; another relay may publish it again');
    }
  }

  /** Records the failure. The row dies when it fails at maxAge or older; until then it is retried after the backoff. */
  protected async fail(store: OutboxStore, claim: OutboxClaim, published: string[], error: unknown): Promise<void> {
    const now = this.Time.now();
    const attempts = claim.row.Attempts + 1;
    const dead = now - claim.row.CreatedAt >= this.maxAgeMs;
    const written = await store.markFailed(claim, {
      Status: dead ? 'dead' : 'pending',
      Attempts: attempts,
      AvailableAt: dead ? claim.row.AvailableAt : now + computeBackoff(this.retry, attempts, this.Options.random),
      LastError: error instanceof Error ? error.message : String(error),
      PublishedTo: published,
    });
    const detail = { error, messageId: claim.row.MessageId, attempts };
    if (!written) this.Log.warn(detail, 'Publishing outbox row ${messageId} failed after the row was claimed by another relay; the failure is not recorded');
    else if (dead) this.Log.error(detail, 'Outbox row ${messageId} is dead: still failing after queue.outbox.maxAge, ${attempts} attempts');
    else this.Log.warn(detail, 'Publishing outbox row ${messageId} failed, attempt ${attempts}');
  }

  /** At most once per retention / 100, then in batchSize chunks until the backlog is gone. */
  protected async purgeIfDue(connection: string, store: OutboxStore): Promise<void> {
    const now = this.Time.now();
    const last = this.lastPurge.get(connection);
    if (last !== undefined && now - last < Math.max(1000, Math.floor(this.retentionMs / 100))) return;
    this.lastPurge.set(connection, now);
    let removed: number;
    do {
      removed = await store.purgePublished(now - this.retentionMs, this.config.batchSize);
    } while (removed === this.config.batchSize);
  }

  /** Resolved on first use: QueueService resolves this relay while it resolves itself. */
  protected async queueService(): Promise<QueueService> {
    return (this.queue ??= await DI.resolve(QueueService));
  }
}
