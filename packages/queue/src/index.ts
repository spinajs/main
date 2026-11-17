import { InvalidArgument, ConnectionNotFound, InvalidOperation, toError } from '@spinajs/exceptions';
import { Autoinject, Constructor, DI, Injectable, ServiceNotFound } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { QueueClient, QueueJob, QueueEvent, IQueueMessage, IJobProgressMeta, QueueMessage, QueueService, JobRetentionService, isJob, PublishDirectOptions } from './interfaces.js';
import { JobModel, JOB_TERMINAL_STATUSES } from './models/JobModel.js';
import { v4 as uuidv4 } from 'uuid';
import { AutoinjectService, registerConfigurationSchema } from '@spinajs/configuration';
import { FaultInjector } from '@spinajs/durable';
import type * as Idempotency from '@spinajs/idempotency';
import { DateTime } from 'luxon';
import { runAroundHandle, runBeforeEmit, tracked } from './hook-runner.js';
import { isPermanentJobFailure } from './hooks.js';
import { OutboxRelay } from './outbox/relay.js';
import { OutboxWriter } from './outbox/writer.js';
import { RedeliverLater } from './redeliver.js';

export * from './BlackHoleQueueClient.js';
export * from './crash.js';
export * from './redeliver.js';
export { SystemTask, systemTaskOf } from '@spinajs/util';
export * from './interfaces.js';
export * from './headers.js';
export * from './outbox/index.js';
export * from './bootstrap.js';
export { QUEUE_OUTBOX_CONFIGURATION_SCHEMA } from './schemas/queue.outbox.configuration.js';
export { QUEUE_CONFIGURATION_SCHEMA } from './schemas/queue.configuration.js';
export * from './decorators.js';
export * from './hooks.js';
export * from './tracking-hook.js';
export * from './models/JobModel.js';
export * from './services/JobRetentionService.js';
export * from './migrations/Queue_2022_10_18_01_13_00.js';
export * from './migrations/Queue_2026_06_30_00_00_00.js';
export * from './migrations/Queue_2026_07_02_00_00_00.js';
export * from './migrations/Queue_2026_07_10_00_00_00.js';
export * from './migrations/Queue_2026_07_17_00_00_00.js';
export * from './migrations/Queue_2026_10_03_00_00_00.js';
export * from './migrations/Queue_2026_10_17_00_00_00.js';
export * from './helpers.js';
export * from './fp.js';

/** Fallback progress-throttle values used when `queue.progress` is not configured. */
const DEFAULT_PROGRESS_MIN_DELTA = 5;
const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 1000;

/** Lengths of the queue_jobs text columns, so a long value cannot fail the row write on a strict-mode DB. */
const LAST_ERROR_MAX_LENGTH = 1024;
const PHASE_MAX_LENGTH = 32;
const MESSAGE_MAX_LENGTH = 512;

function truncate(value: string, max: number): string {
  return value.length > max ? value.substring(0, max) : value;
}

const ACK_REPLY = { kind: 'ack', body: null };

interface EventDedup {
  service: Idempotency.IdempotencyService;
  inFlight: typeof Idempotency.IdempotencyInFlight;
  ttlMs: number;
}

@Injectable(QueueService)
export class DefaultQueueService extends QueueService {
  @Logger('queue')
  protected Log: Log;

  @AutoinjectService('queue.connections', QueueClient)
  protected Connections: Map<string, QueueClient>;

  /**
   * Config-selected retention service that periodically purges old tracked jobs.
   * Started / stopped by DI on injection / disposal. May be undefined if retention
   * is not configured.
   */
  @AutoinjectService('queue.retention', JobRetentionService, { optional: true })
  protected Retention?: JobRetentionService;

  @Autoinject(OutboxWriter)
  protected Outbox: OutboxWriter;

  protected Relay?: OutboxRelay;

  @Autoinject(FaultInjector)
  protected Faults: FaultInjector;

  protected dedup?: Promise<EventDedup>;

  public async resolve(): Promise<void> {
    await super.resolve();
    await this.Outbox.ready();
    if (this.Outbox.Config.enabled && this.Outbox.Config.relay) this.Relay = await DI.resolve(OutboxRelay, [{}]);
  }

  public async dispose() {
    await this.Relay?.stop();

    if (this.Retention) {
      try {
        await this.Retention.dispose();
      } catch (err) {
        this.Log.error(toError(err), 'Cannot dispose job retention service');
      }
    }

    await Promise.all(
      [...this.Connections.values()].map(async (val) => {
        try {
          await val.dispose();
        } catch (err) {
          this.Log.error({ error: err, connection: val.constructor.name }, 'Cannot dispose queue connection ${connection}');
        }
      }),
    );

    this.Connections.clear();
  }

  public async emit(event: IQueueMessage | QueueEvent | QueueJob): Promise<string | undefined> {
    await runBeforeEmit(event);

    event.MessageId = event.MessageId ?? uuidv4();
    // generate only; the consumer writes the row
    const jobId = isJob(event) ? (event.JobId = event.JobId ?? event.MessageId) : undefined;

    // a misrouted message must fail the caller, not wait in the outbox
    this.connectionsFor(event);
    const target = await this.Outbox.enlistOn(event);
    if (target) {
      await target.driver.afterCommit(() => this.Relay?.nudge(target.connection));
      return jobId;
    }

    await this.publishDirect(event);
    // for jobs this is the id the caller uses to track progress / status
    return jobId;
  }

  public async publishDirect(event: IQueueMessage, options: PublishDirectOptions = {}): Promise<void> {
    for (const [name, connection] of this.connectionsFor(event)) {
      if (options.skip?.includes(name)) continue;
      await connection.emit(event);
      options.published?.push(name);
      this.Log.trace({ messageName: event.Name, messageType: event.Type, connection: name }, 'Emitted message ${messageName}, type: ${messageType} to connection ${connection}');
    }
  }

  protected connectionsFor(event: IQueueMessage): Array<[string, QueueClient]> {
    return this.getConnectionsForMessage(event).map((name): [string, QueueClient] => {
      const connection = this.Connections.get(name);
      if (!connection) {
        throw new ConnectionNotFound(`Queue connection ${name} not found. Please check your configuration before emitting events to this connection.`);
      }
      return [name, connection];
    });
  }

  public async stopConsuming(event: Constructor<QueueMessage>) {
    for (const c of this.getConnectionsForMessage(event)) {
      const connection = this.Connections.get(c);
      if (!connection) {
        throw new ConnectionNotFound(`Queue connection ${c} not found. Please check your configuration before unsubscribing from this connection.`);
      }

      await connection.unsubscribe(event);
    }
  }

  /**
   *
   * Starts to consume events/jobs from connection
   *
   * NOTE: When consuming events, we can have multiple event types on same channel, couse
   *       subscribe function filters it out, and event can be handled in another subscription
   *
   *       When consuming jobs, multiple jobs on same channel can have unpredictible behavior becouse
   *       job can be executed once even with multiple subscribers, so filtering it out
   *       prevents from executing it on other subscriptions
   *
   * @param event - event type to consume
   * @param callback - optional callback when job is consumet, mandatory for events
   * @param subscriptionId - optional subscription id if consuming durable events
   * @param durable - is durable event, if not set, this value default to event decorator options
   */
  public async consume<T extends QueueMessage>(event: Constructor<QueueMessage>, callback?: (message: T) => Promise<void>, subscriptionId?: string, durable?: boolean) {
    const options = Reflect.getMetadata('queue:options', event);
    const self = this;

    if (!options) {
      throw new InvalidArgument(`Type ${event.name} is not defined as Job or Event type. Use proper decorator to configure queue events`);
    }

    const { durable: eDurable } = options;
    const connections = this.getConnectionsForMessage(event);

    if ((eDurable || durable) && !subscriptionId) {
      throw new InvalidArgument('subscriptionId should be set when using durable events');
    }

    const dedupSubscription = await this.dedupSubscriptionOf(event, connections, subscriptionId);

    for (let c of connections) {
      const conn = this.Connections.get(c);

      if (!conn) {
        throw new ServiceNotFound(`Queue connection ${c} not found. Please check your configuration before consuming events from this connection.`);
      }

      await conn.subscribe(
        event,
        async (e) => {
          if (e.Name === event.name) {
            const ev = DI.resolve<QueueMessage>(event);
            ev.hydrate(e);

            // routing default applies before the tracking row is created, so MaxAttempts matches
            if (ev instanceof QueueJob && (ev.RetryCount === undefined || ev.RetryCount === null)) {
              const routed = conn.getMaxRetriesForMessage(event);
              if (routed !== undefined) {
                ev.RetryCount = routed;
              }
            }

            /**
             * Handle job type of message
             * To preserve result & handle delay, errors etc..
             */
            if (ev instanceof QueueJob) {
              let jobResult = null;

              // Consumer owns the tracking row. First receipt inserts; a redelivery finds the
              // row from the prior attempt. The queue_jobs.JobId unique index makes a rare
              // concurrent double-receipt safe (second insert collides -> re-read).
              let jModel = await tracked(() => JobModel.where({ JobId: ev.JobId }).first());
              if (!jModel) {
                jModel = new JobModel();
                jModel.JobId = ev.JobId;
                jModel.Name = ev.Name;
                jModel.Connection = c;
                jModel.Attempt = 0;
                jModel.Progress = 0;
                // set Status explicitly so tracking never depends on the DB column default,
                // which can differ across dialects ( and MySQL MODIFY COLUMN can drop it ).
                jModel.Status = 'created';
                // capture the dispatch-time attempt ceiling ( retries + 1 ) so it stays authoritative
                // across redeliveries and consumers can render Attempt/MaxAttempts consistently.
                jModel.MaxAttempts = ((ev as QueueJob).RetryCount ?? 0) + 1;
                jModel.InitiatorType = ev.Initiator?.type;
                jModel.InitiatorId = ev.Initiator?.id;

                try {
                  const row = jModel;
                  await tracked(() => row.insert());
                } catch (insertErr) {
                  // concurrent first-receipt from another worker won the insert; re-read and continue.
                  // No row means the insert failed for another reason, so that error is the one to surface.
                  const existing = await tracked(() => JobModel.where({ JobId: ev.JobId }).first());
                  if (!existing) {
                    throw insertErr;
                  }
                  jModel = existing;
                }
              }

              // A JobId is caller-supplied: a message for a row another initiator owns must not run under, or write into, that row.
              if ((jModel.InitiatorType ?? null) !== (ev.Initiator?.type ?? null) || (jModel.InitiatorId ?? null) !== (ev.Initiator?.id ?? null)) {
                this.Log.warn({ jobName: ev.Name, jobId: ev.JobId }, 'Job ${jobName}:${jobId} dropped: its initiator differs from the one that owns the tracking row');
                await this.beforeAck(ev, subscriptionId);
                return;
              }

              // at-least-once delivery means a job can be redelivered after it already finished
              // ( consumer crash before ack, broker failover ). Skip re-running a job whose tracking
              // row is already terminal so jobs stay idempotent. Acks without re-execution or rethrow.
              if ((this.Configuration?.deduplicate ?? true) && JOB_TERMINAL_STATUSES.includes(jModel.Status)) {
                this.Log.info({ jobName: ev.Name, jobId: ev.JobId, status: jModel.Status }, 'Job ${jobName}:${jobId} already in terminal state ${status}, skipping duplicate delivery');
                await this.beforeAck(ev, subscriptionId);
                return;
              }

              jModel.Status = 'executing';
              jModel.ExecutedAt = DateTime.now();

              // throttle progress persistence: skip writes smaller than the threshold and
              // closer together than the min interval, so a chatty job doesn't hammer the DB.
              let lastProgress = 0;
              let lastProgressAt = 0;
              const minProgressDelta = this.Configuration.progress?.minDelta ?? DEFAULT_PROGRESS_MIN_DELTA;
              const minProgressInterval = this.Configuration.progress?.minInterval ?? DEFAULT_PROGRESS_MIN_INTERVAL_MS;

              try {
                // update executing state
                await tracked(() => jModel.update());

                jobResult = await runAroundHandle(ev, () => ev.execute(onProgress));

                jModel.Result = jobResult;
                jModel.Status = 'success';
                jModel.FinishedAt = DateTime.now();
                jModel.Progress = 100;

                this.Log.trace({ jobName: event.name, result: jModel.Result }, 'Job ${jobName} processed with result ${result}');
              } catch (err) {
                this.Log.error({ error: err, jobName: event.name }, 'Cannot execute job ${jobName}');

                // record the failed attempt and mark the job retrying / dead so the
                // transport can apply its retry-then-dead-letter policy ( re-thrown below ).
                // the error goes to LastError - Result is reserved for the successful output.
                jModel.Attempt = (jModel.Attempt ?? 0) + 1;
                // derive the retry limit from the dispatch-time ceiling captured on the row so it stays
                // authoritative across redeliveries ( a redelivered wire message could carry a different
                // RetryCount ). MaxAttempts is retries + 1, so the limit is MaxAttempts - 1.
                const maxRetries = jModel.MaxAttempts ? jModel.MaxAttempts - 1 : ((ev as QueueJob).RetryCount ?? 0);
                jModel.Status = isPermanentJobFailure(err) || jModel.Attempt > maxRetries ? 'dead' : 'retrying';
                if (jModel.Status === 'dead') {
                  jModel.FinishedAt = DateTime.now();
                }
                jModel.LastError = truncate(err instanceof Error ? err.message : String(err), LAST_ERROR_MAX_LENGTH);

                await tracked(() => jModel.update());

                // notify the job of the failed attempt ( e.g. to send an alert on the final one ).
                // the hook must never mask the original error, so its own failure is only logged.
                try {
                  const failure = { attempt: jModel.Attempt, maxAttempts: jModel.MaxAttempts ?? maxRetries + 1, isFinal: jModel.Status === 'dead', jobId: ev.JobId };
                  await runAroundHandle(ev, () => (ev as QueueJob).onFailed(err, failure));
                } catch (hookErr) {
                  this.Log.error({ error: hookErr, jobName: event.name }, 'onFailed hook for job ${jobName} threw');
                }

                // propagate so the transport sees the failure and can retry / dead-letter.
                // ( previously the error was swallowed and the message silently acked )
                throw err;
              }

              await tracked(() => jModel.update());

              async function onProgress(p: number, meta?: IJobProgressMeta) {
                const now = DateTime.now().toMillis();
                const isFinal = p >= 100;
                const hasMeta = meta?.phase !== undefined || meta?.message !== undefined;

                // apply meta eagerly so a phase / message change is never lost to throttling
                if (meta?.phase !== undefined) {
                  jModel.Phase = truncate(meta.phase, PHASE_MAX_LENGTH);
                }
                if (meta?.message !== undefined) {
                  jModel.Message = truncate(meta.message, MESSAGE_MAX_LENGTH);
                }

                // always persist the final 100% or a meta change; otherwise throttle by delta + time
                if (!isFinal && !hasMeta && p - lastProgress < minProgressDelta && now - lastProgressAt < minProgressInterval) {
                  jModel.Progress = p;
                  return;
                }

                lastProgress = p;
                lastProgressAt = now;
                jModel.Progress = p;
                await tracked(() => jModel.update());

                self.Log.trace({ jobName: event.name, jobId: jModel.JobId, progress: p }, 'Job ${jobName}:${jobId} progress: ${progress}%');
              }
            }

            if (!callback && ev instanceof QueueEvent) {
              throw new InvalidArgument('when subscribing to events, callback cannot be null. Subscriber should handle event in callback function !');
            }

            this.Log.trace({ messageName: event.name }, 'Queue message ${messageName} processed');

            if (callback) {
              const handle = () => runAroundHandle(ev, () => callback(ev as T));
              await (dedupSubscription === undefined ? handle() : this.handleEventOnce(dedupSubscription, ev, handle));
            }

            await this.beforeAck(ev, subscriptionId);
          }
        },
        subscriptionId,
        durable ?? eDurable ?? false,
      );
    }
  }

  /** The delivery is done with and what follows is the transport's ack; a crash here leaves it unsettled, so it comes again. */
  protected async beforeAck(message: IQueueMessage, subscriptionId: string | undefined): Promise<void> {
    await this.Faults.point('queue.before-ack', { messageId: message.MessageId, subscriptionId });
  }

  /** The subscription a consumed event is deduplicated under, or undefined when deduplication does not apply to it. */
  protected async dedupSubscriptionOf(event: Constructor<QueueMessage>, connections: string[], subscriptionId: string | undefined): Promise<string | undefined> {
    const options: unknown = Reflect.getMetadata('queue:options', event);
    const isEvent = typeof options === 'object' && options !== null && 'type' in options && options.type === 'event';
    if (!isEvent || !subscriptionId || this.Configuration.deduplicateEvents !== true || this.Configuration.deduplicate === false) {
      return undefined;
    }
    for (const c of connections) {
      if (this.Connections.get(c)?.RedeliversFailedEvents === false) {
        throw new InvalidOperation(`queue.deduplicateEvents: connection ${c} acks a failed event instead of redelivering it (RedeliversFailedEvents is false), so an in-flight duplicate would be lost`);
      }
    }
    await this.eventDedup();
    return subscriptionId;
  }

  /** An event without a MessageId has nothing to be deduplicated by, so it is handled as it comes. */
  protected async handleEventOnce(subscriptionId: string, message: QueueMessage, handle: () => Promise<void>): Promise<void> {
    if (!(message instanceof QueueEvent) || !message.MessageId) {
      return handle();
    }
    const { service, inFlight, ttlMs } = await this.eventDedup();
    try {
      await service.run({ namespace: `queue:${subscriptionId}` }, message.MessageId, handle, { ttl: ttlMs, toReply: () => ACK_REPLY, fromReply: () => undefined });
    } catch (error) {
      if (error instanceof inFlight) throw new RedeliverLater(error.retryAfterMs, error);
      throw error;
    }
  }

  /** Imported on first use, as `@spinajs/http` does: apps that never deduplicate events need no __idempotency table. */
  protected eventDedup(): Promise<EventDedup> {
    if (this.dedup) return this.dedup;
    const loading = this.loadEventDedup();
    this.dedup = loading;
    // a failed load is not kept: the next subscription or delivery tries again
    loading.catch(() => {
      if (this.dedup === loading) this.dedup = undefined;
    });
    return loading;
  }

  protected async loadEventDedup(): Promise<EventDedup> {
    let idempotency: typeof Idempotency;
    try {
      idempotency = await import('@spinajs/idempotency');
    } catch (err) {
      throw new InvalidOperation('queue.deduplicateEvents needs the @spinajs/idempotency package installed', err);
    }
    // a wrong idempotency.* value fails the subscription, not the first delivery
    registerConfigurationSchema(idempotency.IDEMPOTENCY_CONFIGURATION_SCHEMA, DI.RootContainer);
    const service = await DI.resolve(idempotency.IdempotencyService);
    if (service.Store instanceof idempotency.OrmIdempotencyStore && idempotency.ormModelRegistered(DI.RootContainer) === false) {
      throw new InvalidOperation("queue.deduplicateEvents on OrmIdempotencyStore: the Orm resolved before @spinajs/idempotency was imported, so __idempotency has neither a model nor a migration. Add import '@spinajs/idempotency' to the app entry, before the boot");
    }
    return { service, inFlight: idempotency.IdempotencyInFlight, ttlMs: service.ttlOf(this.Configuration.deduplicateTtl ?? '7d', 'queue.deduplicateTtl') };
  }

  /**
   * Get specific queue client connection. If no connection param is provided, default is returned.
   * @param connection - connection name to obtain
   * @returns
   */
  public get(connection?: string): QueueClient {
    return this.Connections.get(`${connection ?? this.Configuration.default}`)!;
  }
}
