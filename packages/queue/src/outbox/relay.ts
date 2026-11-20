import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Config } from '@spinajs/configuration';
import { AsyncService, Autoinject, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import type { IInstanceCheck } from '@spinajs/di';
import { Clock, DbClock, FaultInjector, type NormalizedRetry } from '@spinajs/durable';
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
    }
  }

  // Claims, publishes, marks and releases run one statement at a time: the caller may hand this pass a transaction
  // context, and statements of one transaction must not run in parallel.
  protected async drain(connection: string, store: OutboxStore): Promise<void> {
    const now = this.Time.now();
    const claims: OutboxClaim[] = [];
    for (const row of await store.due(now, this.config.batchSize)) {
      const claim = await store.claim(row, this.replicaId, this.config.claimTtl, now);
      if (claim) claims.push(claim);
    }

    for (const [i, claim] of claims.entries()) {
      if (this.Time.now() + this.config.maxPublishMs > claim.until) {
        for (const left of claims.slice(i)) await store.release(left);
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

  /** Lets the row go, so the next pass tries it again. */
  protected async fail(store: OutboxStore, claim: OutboxClaim, _published: string[], error: unknown): Promise<void> {
    this.Log.error({ error, messageId: claim.row.MessageId }, 'Publishing outbox row ${messageId} failed');
    await store.release(claim);
  }

  /** Resolved on first use: QueueService resolves this relay while it resolves itself. */
  protected async queueService(): Promise<QueueService> {
    return (this.queue ??= await DI.resolve(QueueService));
  }
}
