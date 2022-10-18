import { ResolveException } from './../../di/src/exceptions';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { AsyncService, DI, IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IQueueConfiguration, QueueClient, QueueJob, QueueEvent, IQueueMessage, IQueueJob } from './interfaces';
import { ClassInfo, ListFromFiles } from '@spinajs/reflection';
import { JobModel } from './models/JobModel';
import { v4 as uuidv4 } from 'uuid';

export * from './interfaces';
export * from './decorators';
export * from './bootstrap';
export * from './models/JobModel';

export class Queues extends AsyncService {
  @Logger('queue')
  protected Log: Log;

  @Config('queue')
  protected Configuration: IQueueConfiguration;

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.jobs')
  protected Jobs: Array<ClassInfo<QueueJob>>;

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.events')
  protected Events: Array<ClassInfo<QueueEvent>>;

  public async resolve(): Promise<void> {
    for (const c of this.Configuration.connections) {
      this.Log.trace(`Found queue ${c.name}, with transport: ${c.transport}, of type: ${c.type}`);

      DI.register(async (container: IContainer) => {
        if (!container.hasRegisteredType(QueueClient, c.transport)) {
          throw new ResolveException(`Queue client of type ${c.transport} is not registered in DI container.`);
        }

        return await container.resolve(QueueClient, [c]);
      }).as(`__queue__${c.name}`);
    }

    await super.resolve();
  }

  public async emit(event: IQueueMessage, connection?: string) {
    const cName = connection ? connection : this.Configuration.default;
    const c = this.get(connection ? connection : this.Configuration.default);
    if (!c) {
      throw new UnexpectedServerError(`Queue ${cName} not exists !`);
    }

    if (event.Type === 'job') {
      const jModel = new JobModel();

      jModel.JobId = uuidv4();
      jModel.Name = event.Name;

      await jModel.insert();

      (event as IQueueJob).JobId = jModel.JobId;
    }

    return c.emit(event);
  }

  public async consumeEvent(connection: string, channel: string, callback: (message: QueueEvent) => Promise<void>, subscriptionId?: string, durable?: boolean) {
    const c = this.get(connection);

    c.subscribe(
      channel,
      async (e: IQueueMessage) => {
        const eClass = this.Jobs.find((x) => x.name === e.Name);

        if (!eClass) {
          throw new UnexpectedServerError(`Event class ${e.Name} is not registered`);
        }

        const eInstance = DI.resolve<QueueEvent>(eClass.type);
        eInstance.hydrate(e);

        await callback(eInstance);

        this.Log.trace(`Event ${eClass.name} processed`);
      },
      subscriptionId,
      durable,
    );
  }

  public async consumeJob(connection: string, channel: string): Promise<void> {
    const c = this.get(connection);
    const self = this;

    if (!c) {
      throw new UnexpectedServerError(`Queue ${connection} not exists !`);
    }

    c.subscribe(channel, async (e: IQueueJob) => {
      const jClass = this.Jobs.find((x) => x.name === e.Name);

      if (!jClass) {
        throw new UnexpectedServerError(`Job class ${e.Name} is not registered`);
      }

      const jInstance = DI.resolve<QueueJob>(jClass.type);
      const jModel = await JobModel.where({ JobId: e.JobId }).firstOrThrow(new UnexpectedServerError(`No model found for jobId ${e.JobId}`));

      jModel.Status = 'executing';

      jInstance.hydrate(e);

      let jobResult = null;

      try {
        // TODO: implement retry count & dead letter
        if (jInstance.Delay != 0) {
          jobResult = await _executeDelayed(jInstance);
        } else {
          jobResult = await jInstance.execute(onProgress);
        }

        jModel.Result = jobResult;
        jModel.Status = 'success';

        this.Log.trace(`Job ${jClass.name} processed with result ${JSON.stringify(jModel.Result)}`);
      } catch (err) {
        this.Log.error(err, `Cannot execute job ${jClass.name}`);

        jModel.Result = {
          message: err.message,
        };
        jModel.Status = 'error';
      }

      await jModel.update();

      async function onProgress(p: number) {
        jModel.Progress = p;
        await jModel.update();

        self.Log.trace(`Job ${jClass.name}:${jModel.JobId} progress: ${p}%`);
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
    });
  }

  public get(connection?: string) {
    return DI.get<QueueClient>(`__queue__${connection ?? this.Configuration.default}`);
  }
}
