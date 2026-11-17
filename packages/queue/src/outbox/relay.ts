import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Config } from '@spinajs/configuration';
import { AsyncService, Autoinject, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import type { IInstanceCheck } from '@spinajs/di';
import { Clock, computeBackoff, DbClock, FaultInjector, parseDuration, type NormalizedRetry } from '@spinajs/durable';
import { Log, Logger } from '@spinajs/log';
import { Orm } from '@spinajs/orm';
import { isCrash } from '../crash.js';
import { QueueService } from '../interfaces.js';
import { outboxConfig, outboxRetry, type IQueueOutboxConfig } from './config.js';
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
  }

  /** One pass over every outbox connection. Concurrent callers share the pass in progress. */
  public tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  protected async pass(): Promise<void> {
    await this.Time.sync();
    for (const [connection, store] of this.stores) {
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

    for (const [i, claim] of claims.entries()) {
      if (this.Time.now() + this.config.maxPublishMs > claim.until) {
        for (const left of claims.slice(i)) {
          if (!(await store.release(left))) {
            this.Log.warn({ messageId: left.row.MessageId, connection }, 'Outbox row ${messageId} on ${connection} was claimed by another relay before this one reached it');
          }
        }
        return;
      }
      await this.publishRow(connection, store, claim);
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
