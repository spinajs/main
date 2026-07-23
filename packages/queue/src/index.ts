import { UnexpectedServerError, InvalidArgument, ConnectionNotFound } from '@spinajs/exceptions';
import { Constructor, DI, Injectable, ServiceNotFound } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { QueueClient, QueueJob, QueueEvent, IQueueMessage, IJobProgressMeta, QueueMessage, QueueService, JobRetentionService, isJob } from './interfaces.js';
import { JobModel, JOB_TERMINAL_STATUSES } from './models/JobModel.js';
import { v4 as uuidv4 } from 'uuid';
import { AutoinjectService } from '@spinajs/configuration';
import { DateTime } from 'luxon';

export * from './BlackHoleQueueClient.js';
export * from './interfaces.js';
export * from './decorators.js';
export * from './models/JobModel.js';
export * from './services/JobRetentionService.js';
export * from './migrations/Queue_2022_10_18_01_13_00.js';
export * from './migrations/Queue_2026_06_30_00_00_00.js';
export * from './migrations/Queue_2026_07_02_00_00_00.js';
export * from './migrations/Queue_2026_07_10_00_00_00.js';
export * from './migrations/Queue_2026_07_17_00_00_00.js';
export * from './fp.js';

/** Fallback progress-throttle values used when `queue.progress` is not configured. */
const DEFAULT_PROGRESS_MIN_DELTA = 5;
const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 1000;

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
  @AutoinjectService('queue.retention', JobRetentionService)
  protected Retention?: JobRetentionService;

  public async dispose() {
    if (this.Retention) {
      try {
        await this.Retention.dispose();
      } catch (err) {
        this.Log.error(err, 'Cannot dispose job retention service');
      }
    }

    this.Connections.forEach(async (val) => {
      try {
        await val.dispose();
      } catch (err) {
        this.Log.error(err, `Cannot dispose queue connection ${val.constructor.name}`);
      }
    });

    this.Connections.clear();
  }

  public async emit(event: IQueueMessage | QueueEvent | QueueJob): Promise<string | undefined> {
    const connections = this.getConnectionsForMessage(event);
    let jobId: string | undefined;

    for (let c of connections) {
      const connection = this.Connections.get(c);
      if (!connection) {
        throw new ConnectionNotFound(`Queue connection ${c} not found. Please check your configuration before emitting events to this connection.`);
      }

      if (isJob(event)) {
        event.JobId = event.JobId ?? uuidv4(); // generate only; consumer writes the row
        jobId = event.JobId;
      }

      await connection.emit(event);

      this.Log.trace(`Emitted message ${event.Name}, type: ${event.Type} to connection ${c}`);
    }

    // for jobs this is the id the caller uses to track progress / status
    return jobId;
  }

  public async stopConsuming(event: Constructor<QueueMessage>) {
    this.getConnectionsForMessage(event).forEach((c) => this.Connections.get(c)!.unsubscribe(event));
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

            /**
             * Handle job type of message
             * To preserve result & handle delay, errors etc..
             */
            if (ev instanceof QueueJob) {
              let jobResult = null;

              // Consumer owns the tracking row. First receipt inserts; a redelivery finds the
              // row from the prior attempt. The queue_jobs.JobId unique index makes a rare
              // concurrent double-receipt safe (second insert collides -> re-read).
              let jModel = await JobModel.where({ JobId: ev.JobId }).first();
              if (!jModel) {
                jModel = new JobModel();
                jModel.JobId = ev.JobId;
                jModel.Name = ev.Name;
                jModel.Connection = c;
                jModel.Attempt = 0;
                jModel.Progress = 0;
                // capture the dispatch-time retry limit so it stays authoritative across redeliveries.
                jModel.MaxAttempts = (ev as QueueJob).RetryCount ?? 0;

                try {
                  await jModel.insert();
                } catch (e) {
                  // concurrent first-receipt from another worker won the insert; re-read and continue.
                  jModel = await JobModel.where({ JobId: ev.JobId }).firstOrThrow(new UnexpectedServerError(`No model found for jobId ${ev.JobId}`));
                }
              }

              // at-least-once delivery means a job can be redelivered after it already finished
              // ( consumer crash before ack, broker failover ). Skip re-running a job whose tracking
              // row is already terminal so jobs stay idempotent. Acks without re-execution or rethrow.
              if ((this.Configuration?.deduplicate ?? true) && JOB_TERMINAL_STATUSES.includes(jModel.Status)) {
                this.Log.info(`Job ${ev.Name}:${ev.JobId} already in terminal state ${jModel.Status}, skipping duplicate delivery`);
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
                await jModel.update();

                jobResult = await ev.execute(onProgress);

                jModel.Result = jobResult;
                jModel.Status = 'success';
                jModel.FinishedAt = DateTime.now();
                jModel.Progress = 100;

                this.Log.trace(`Job ${event.name} processed with result ${JSON.stringify(jModel.Result)}`);
              } catch (err) {
                this.Log.error(err, `Cannot execute job ${event.name}`);

                // record the failed attempt and mark the job retrying / dead so the
                // transport can apply its retry-then-dead-letter policy ( re-thrown below ).
                // the error goes to LastError - Result is reserved for the successful output.
                jModel.Attempt = (jModel.Attempt ?? 0) + 1;
                // prefer the dispatch-time limit captured on the row so it stays authoritative
                // across redeliveries ( a redelivered wire message could carry a different RetryCount ).
                const maxRetries = jModel.MaxAttempts ?? (ev as QueueJob).RetryCount ?? 0;
                jModel.Status = jModel.Attempt > maxRetries ? 'dead' : 'retrying';
                jModel.LastError = err instanceof Error ? err.message : String(err);

                await jModel.update();

                // notify the job of the failed attempt ( e.g. to send an alert on the final one ).
                // the hook must never mask the original error, so its own failure is only logged.
                try {
                  await (ev as QueueJob).onFailed(err, { attempt: jModel.Attempt, maxAttempts: maxRetries, isFinal: jModel.Status === 'dead', jobId: ev.JobId });
                } catch (hookErr) {
                  this.Log.error(hookErr, `onFailed hook for job ${event.name} threw`);
                }

                // propagate so the transport sees the failure and can retry / dead-letter.
                // ( previously the error was swallowed and the message silently acked )
                throw err;
              }

              await jModel.update();

              async function onProgress(p: number, meta?: IJobProgressMeta) {
                const now = DateTime.now().toMillis();
                const isFinal = p >= 100;
                const hasMeta = meta?.phase !== undefined || meta?.message !== undefined;

                // apply meta eagerly so a phase / message change is never lost to throttling
                if (meta?.phase !== undefined) {
                  jModel.Phase = meta.phase;
                }
                if (meta?.message !== undefined) {
                  jModel.Message = meta.message;
                }

                // always persist the final 100% or a meta change; otherwise throttle by delta + time
                if (!isFinal && !hasMeta && p - lastProgress < minProgressDelta && now - lastProgressAt < minProgressInterval) {
                  jModel.Progress = p;
                  return;
                }

                lastProgress = p;
                lastProgressAt = now;
                jModel.Progress = p;
                await jModel.update();

                self.Log.trace(`Job ${event.name}:${jModel.JobId} progress: ${p}%`);
              }
            }

            if (!callback && ev instanceof QueueEvent) {
              throw new InvalidArgument('when subscribing to events, callback cannot be null. Subscriber should handle event in callback function !');
            }

            this.Log.trace(`Queue message ${event.name} processed`);

            if (callback) {
              return callback(ev as T);
            }
          }
        },
        subscriptionId,
        durable ?? eDurable ?? false,
      );
    }
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
