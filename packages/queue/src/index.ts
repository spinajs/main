import { UnexpectedServerError, InvalidArgument, ConnectionNotFound, ResourceNotFound } from '@spinajs/exceptions';
import { Constructor, DI, Injectable, ServiceNotFound } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { QueueClient, QueueJob, QueueEvent, IQueueMessage, QueueMessage, QueueService, isJob } from './interfaces.js';
import { JobModel } from './models/JobModel.js';
import { DeadLetterModel } from './models/DeadLetterModel.js';
import { v4 as uuidv4 } from 'uuid';
import { AutoinjectService } from '@spinajs/configuration';
import { ResiliencePipelineBuilder } from '@spinajs/util';
import { DateTime } from 'luxon';

export * from './BlackHoleQueueClient.js';
export * from './interfaces.js';
export * from './decorators.js';
export * from './models/JobModel.js';
export * from './models/DeadLetterModel.js';
export * from './migrations/Queue_2022_10_18_01_13_00.js';
export * from './migrations/Queue_2026_06_30_00_00_00.js';
export * from './fp.js';

@Injectable(QueueService)
export class DefaultQueueService extends QueueService {
  @Logger('queue')
  protected Log: Log;

  @AutoinjectService('queue.connections', QueueClient)
  protected Connections: Map<string, QueueClient>;

  public async dispose() {
    this.Connections.forEach(async (val) => {
      try {
        await val.dispose();
      } catch (err) {
        this.Log.error(err, `Cannot dispose queue connection ${val.constructor.name}`);
      }
    });

    this.Connections.clear();
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
             * To preserve result & handle delay, errors, retries & dead lettering
             */
            if (ev instanceof QueueJob) {
              await self.executeJob(ev, event, c);
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

  /**
   * Re-emits a dead lettered message and removes its dead letter entry.
   */
  public async requeueDeadLetter(id: number): Promise<void> {
    const entry = await DeadLetterModel.where({ Id: id }).firstOrThrow(new ResourceNotFound(`Dead letter entry ${id} not found`));

    await this.emit(entry.Payload as IQueueMessage);
    await entry.destroy();

    this.Log.trace(`Requeued dead letter ${id} (${entry.Name})`);
  }

  /**
   * Executes a job applying the connection retry policy. On success the result is stored,
   * on final failure the job is dead lettered ( both in the jobs table and the dead letter store ).
   */
  protected async executeJob(job: QueueJob, event: Constructor<QueueMessage>, connectionName: string) {
    const jModel = await JobModel.where({ JobId: job.JobId }).firstOrThrow(new UnexpectedServerError(`No model found for jobId ${job.JobId}`));
    const cfg = this.Configuration.connections.find((c) => c.name === connectionName);
    const retry = cfg?.retry;
    const maxRetries = job.RetryCount ?? retry?.maxRetries ?? 0;

    const onProgress = async (p: number) => {
      jModel.Progress = p;
      await jModel.update();
      this.Log.trace(`Job ${event.name}:${jModel.JobId} progress: ${p}%`);
    };

    const pipeline = new ResiliencePipelineBuilder<unknown>()
      .addRetry({
        MaxRetryAttempts: maxRetries,
        Delay: retry?.delay ?? 1000,
        MaxDelay: retry?.maxDelay ?? 30000,
        BackoffType: retry?.backoff ?? 'Exponential',
        UseJitter: true,
        OnRetry: async ({ AttemptNumber, Outcome }) => {
          jModel.Status = 'retrying';
          jModel.RetryCount = AttemptNumber;
          jModel.LastError = errorMessage(Outcome.Error);
          await jModel.update();
          this.Log.warn(`Retrying job ${event.name}:${jModel.JobId}, attempt ${AttemptNumber}/${maxRetries}`);
        },
      })
      .build();

    jModel.Status = 'executing';
    jModel.RetryCount = 0;
    jModel.ExecutedAt = DateTime.now();
    await jModel.update();

    try {
      jModel.Result = await pipeline.execute(() => job.execute(onProgress));
      jModel.Status = 'success';
      jModel.Progress = 100;
      jModel.FinishedAt = DateTime.now();
      await jModel.update();

      this.Log.trace(`Job ${event.name} processed with result ${JSON.stringify(jModel.Result)}`);
    } catch (err) {
      this.Log.error(err, `Job ${event.name}:${jModel.JobId} failed after ${maxRetries} retries, moving to dead letter`);

      jModel.Status = 'dead-letter';
      jModel.LastError = errorMessage(err);
      jModel.Result = { message: errorMessage(err) };
      jModel.DeadLetteredAt = DateTime.now();
      jModel.FinishedAt = DateTime.now();
      await jModel.update();

      await this.deadLetter(job, jModel, connectionName, err);
    }
  }

  /**
   * Persists a failed message into the dead letter store for later inspection / requeue.
   */
  protected async deadLetter(job: QueueJob, jModel: JobModel<unknown>, connectionName: string, error: unknown) {
    const entry = new DeadLetterModel();

    entry.JobId = job.JobId;
    entry.Name = job.Name;
    entry.Type = job.Type;
    entry.Connection = connectionName;
    entry.Payload = job;
    entry.Error = errorMessage(error);
    entry.RetryCount = jModel.RetryCount ?? 0;
    entry.FailedAt = DateTime.now();

    await entry.insert();

    this.Log.trace(`Job ${job.Name}:${job.JobId} moved to dead letter store (entry ${entry.Id})`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
