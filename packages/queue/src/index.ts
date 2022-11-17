import { UnexpectedServerError, InvalidArgument } from '@spinajs/exceptions';
import { Constructor, DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { QueueClient, QueueJob, QueueEvent, IQueueMessage, QueueMessage, QueueService, isJob } from './interfaces';
import { JobModel } from './models/JobModel';
import { v4 as uuidv4 } from 'uuid';
import { AutoinjectService } from '@spinajs/configuration';
import { DateTime } from 'luxon';

export * from './BlackHoleQueueClient';
export * from './interfaces';
export * from './decorators';
export * from './models/JobModel';
export * from './migrations/Queue_2022_10_18_01_13_00';

@Injectable(QueueService)
export class DefaultQueueService extends QueueService {
  @Logger('queue')
  protected Log: Log;

  @AutoinjectService('queue.connections', QueueClient)
  protected Connections: Map<string, QueueClient>;

  public async dispose() {
    this.Connections.forEach(async (val) => {
      await val.dispose();
    });

    this.Connections.clear();
  }

  public async emit(event: IQueueMessage | QueueEvent | QueueJob) {
    const connections = this.getConnectionsForMessage(event);

    for (let c of connections) {
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

      this.Connections.get(c).emit(event);
      this.Log.trace(`Emitted message ${event.Name}, type: ${event.Type} to connection ${c}`);
    }
  }

  public async stopConsuming(event: Constructor<QueueMessage>) {
    this.getConnectionsForMessage(event).forEach((c) => this.Connections.get(c).unsubscribe(event));
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
              jModel.Status = 'executing';
              jModel.ExecutedAt = DateTime.now();

              // update executing state
              await jModel.update();

              try {
                // TODO: implement retry count & dead letter
                if (ev.Delay) {
                  jobResult = await _executeDelayed(ev);
                } else {
                  jobResult = await ev.execute(onProgress);
                }

                jModel.Result = jobResult;
                jModel.Status = 'success';
                jModel.FinishedAt = DateTime.now();
                jModel.Progress = 100;

                this.Log.trace(`Job ${event.name} processed with result ${JSON.stringify(jModel.Result)}`);
              } catch (err) {
                this.Log.error(err, `Cannot execute job ${event.name}`);

                jModel.Result = {
                  message: err.message,
                };
                jModel.Status = 'error';
              }

              await jModel.update();

              async function onProgress(p: number) {
                jModel.Progress = p;
                await jModel.update();

                self.Log.trace(`Job ${event.name}:${jModel.JobId} progress: ${p}%`);
              }

              async function _executeDelayed(jobInstance: QueueJob) {
                return new Promise((res, rej) => {
                  setTimeout(() => {
                    jobInstance
                      .execute(onProgress)
                      .then((result) => {
                        res(result);
                      })
                      .catch((err) => {
                        rej(err);
                      });
                  }, jobInstance.Delay);
                });
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
  public get(connection?: string) {
    return this.Connections.get(`${connection ?? this.Configuration.default}`);
  }
}
