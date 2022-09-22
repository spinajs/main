import { Message, QueueClient } from '@spinajs/queue';
import { Event } from './models/event';
import { Subscriber } from './models/Subscriber';
import { Config } from '@spinajs/configuration';
import { Queue } from './models/Queue';
import { ILog, Logger } from '@spinajs/log';

interface QueueOrmTransportConfig {
  TickInterval: number;
}

export class QueueOrmTransport extends QueueClient {
  @Logger('QueueOrmTransport')
  protected Log: ILog;

  @Config('queue.orm_transport')
  protected Config: QueueOrmTransportConfig;

  protected Subscriber: Subscriber;

  public async resolve(): Promise<void> {
    this.Subscriber = await Subscriber.where('Name', this.Options.name).first();

    if (!this.Subscriber) {
      this.Subscriber = new Subscriber({
        Name: this.Options.name,
      });

      await this.Subscriber.insert();

      this.Log.success(`Added ${this.Options.name} subscriber to queue`);
    }
  }

  public async dispatch(event: Message): Promise<boolean> {
    try {
      const e = new Event({
        Channel: event.Queue,
        Value: event.toJSON(),
      });

      const subscriber = await Subscriber.getOrCreate(null, {
        Name: this.Options.name,
      });

      await e.insert();
      await subscriber.Events.add(e);
    } catch (err) {
      return false;
    }

    return true;
  }

  public async subscribe(callback: (message: Message) => void) {
    setInterval(async () => {
      for (const e of sub.Events) {
        try {
          callback(e.Value as Message);
          await Queue.update({ Ack: true }).where('Id', e.Id);
        } catch (err) {
          this.Log.warn(`Cannot execute event ${e.constructor.name}, reason: ${JSON.stringify(err)}`);
        }
      }
    }, this.Config.TickInterval || 1000);
  }
}
