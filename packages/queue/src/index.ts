import { UnexpectedServerError, InvalidArgument, ConnectionNotFound } from '@spinajs/exceptions';
import { Constructor, DI, Injectable, ServiceNotFound } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { QueueClient, QueueJob, QueueEvent, IQueueMessage, QueueMessage, QueueService, isJob } from './interfaces.js';
import { JobModel, JobStatus, JOB_TERMINAL_STATUSES } from './models/JobModel.js';
import { v4 as uuidv4 } from 'uuid';
import { AutoinjectService } from '@spinajs/configuration';
import { DateTime } from 'luxon';

export * from './BlackHoleQueueClient.js';
export * from './interfaces.js';
export * from './decorators.js';
export * from './models/JobModel.js';
export * from './migrations/Queue_2022_10_18_01_13_00.js';
export * from './migrations/Queue_2026_06_30_00_00_00.js';
export * from './migrations/Queue_2026_07_02_00_00_00.js';
export * from './fp.js';

/** Minimum progress delta ( % ) that triggers a throttled progress DB write. */
const PROGRESS_MIN_DELTA = 5;
/** Minimum time ( ms ) between throttled progress DB writes. */
const PROGRESS_MIN_INTERVAL_MS = 1000;

@Injectable(QueueService)
export class DefaultQueueService extends QueueService {
  @Logger('queue')
  protected Log: Log;

  @AutoinjectService('queue.connections', QueueClient)
  protected Connections: Map<string, QueueClient>;

  protected RetentionTimer?: ReturnType<typeof setInterval>;

  public async resolve() {
    await super.resolve();
    this.startRetention();
  }

  public async dispose() {
    if (this.RetentionTimer) {
      clearInterval(this.RetentionTimer);
      this.RetentionTimer = undefined;
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

  /**
   * Starts the periodic job-retention purge when configured. No-op if retention is disabled.
   */
  protected startRetention() {
    const retention = this.Configuration.retention;
    if (!retention?.enabled || !retention.maxAge) {
      return;
    }

    const interval = retention.interval ?? 60 * 60 * 1000;

    this.RetentionTimer = setInterval(() => {
      const cutoff = DateTime.now().minus({ milliseconds: retention.maxAge });
      this.purgeJobs(cutoff, retention.statuses)
        .then((n) => {
          if (n > 0) {
            this.Log.info(`Retention purge removed ${n} job(s) older than ${cutoff.toISO()}`);
          }
        })
        .catch((err) => this.Log.error(err, 'Job retention purge failed'));
    }, interval);

    // don't keep the process alive just for the purge timer
    (this.RetentionTimer as { unref?: () => void }).unref?.();

    this.Log.info(`Job retention enabled: purging jobs older than ${retention.maxAge}ms every ${interval}ms`);
  }

  /**
   * Deletes terminal ( or given ) jobs created before `olderThan`. The set is selected with the
   * JobModel query scopes ( status + date ), then removed by id.
   */
  public async purgeJobs(olderThan: DateTime, statuses?: string[]): Promise<number> {
    const rows = await JobModel.query()
      .columns(['Id'])
      .withStatus((statuses as JobStatus[]) ?? JOB_TERMINAL_STATUSES)
      .olderThan(olderThan);

    const ids = rows.map((r) => r.Id);
    if (ids.length === 0) {
      return 0;
    }

    await JobModel.destroy(ids);
    return ids.length;
  }

  public async emit(event: IQueueMessage | QueueEvent | QueueJob) {
    const connections = this.getConnectionsForMessage(event);

    for (let c of connections) {
      const connection = this.Connections.get(c);
      if (!connection) {
        throw new ConnectionNotFound(`Queue connection ${c} not found. Please check your configuration before emitting events to this connection.`);
      }

      if (isJob(event)) {
        const jModel = new JobModel();

        jModel.JobId = uuidv4();
        jModel.Name = event.Name;
        jModel.Status = 'created';
        jModel.Progress = 0;
        jModel.Attempt = 0;
        jModel.MaxAttempts = (event as QueueJob).RetryCount ?? 0;
        jModel.Connection = c;

        await jModel.insert();

        event.JobId = jModel.JobId;
      }

      await connection.emit(event);

      this.Log.trace(`Emitted message ${event.Name}, type: ${event.Type} to connection ${c}`);
    }
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
              const jModel = await JobModel.where({ JobId: ev.JobId }).firstOrThrow(new UnexpectedServerError(`No model found for jobId ${ev.JobId}`));

              // idempotency: messaging is at-least-once, so the same job can be redelivered
              // ( consumer crash, broker failover ). Skip if it already reached a terminal state.
              if (this.Configuration.deduplicate !== false && (jModel.Status === 'success' || jModel.Status === 'dead')) {
                // return normally ( no throw ) so the transport acks and drops the duplicate
                this.Log.warn(`Job ${event.name}:${jModel.JobId} already ${jModel.Status}, skipping duplicate delivery`);
                return;
              }

              jModel.Status = 'executing';
              jModel.ExecutedAt = DateTime.now();

              // throttle progress persistence: skip writes smaller than the threshold and
              // closer together than the min interval, so a chatty job doesn't hammer the DB.
              let lastProgress = 0;
              let lastProgressAt = 0;

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
                const maxRetries = (ev as QueueJob).RetryCount ?? 0;
                jModel.Status = jModel.Attempt > maxRetries ? 'dead' : 'retrying';
                jModel.LastError = err instanceof Error ? err.message : String(err);

                await jModel.update();

                // propagate so the transport sees the failure and can retry / dead-letter.
                // ( previously the error was swallowed and the message silently acked )
                throw err;
              }

              await jModel.update();

              async function onProgress(p: number) {
                const now = DateTime.now().toMillis();
                const isFinal = p >= 100;

                // always persist the final 100%; otherwise throttle by delta + time
                if (!isFinal && p - lastProgress < PROGRESS_MIN_DELTA && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) {
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
