import { MessageBase, QueueTransport } from '@spinajs/queue';
import { Event } from './models/event';
import { Subscriber } from './models/Subscriber';
import { Config } from '@spinajs/configuration';
import { Queue } from './models/Queue';
import { ILog, Logger } from '@spinajs/log';

interface QueueOrmTransportConfig {
  TickInterval: number;
}

export class QueueOrmTransport extends QueueTransport {
  @Logger('QueueOrmTransport')
  protected Log: ILog;

  @Config('queue.orm_transport')
  protected Config: QueueOrmTransportConfig;

  public async dispatch(event: MessageBase): Promise<boolean> {
    try {
      const e = new Event({
        Channel: event.Channel,
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

  public async subscribe(callback: (message: MessageBase) => void) {
    setInterval(async () => {
      const sub = await Subscriber.where('Name', this.Options.name)
        .populate('Events', function () {
          this.where('Ack', false);
        })
        .first();

      for (const e of sub.Events) {
        try {
          callback(e.Value as MessageBase);
          await Queue.update({ Ack: true }).where('Id', e.Id);
        } catch (err) {
          this.Log.warn(`Cannot execute event ${e.constructor.name}, reason: ${JSON.stringify(err)}`);
        }
      }
    }, this.Config.TickInterval || 1000);
  }
}
