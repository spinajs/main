import { EventEmitter } from 'eventemitter3';
import { MessageBase, QueueTransport } from './interfaces';

export class EventEmitterTransport extends QueueTransport {
  protected Emitter = new EventEmitter();

  public async dispatch(event: MessageBase): Promise<boolean> {
    this.Emitter.emit('event', event);
    return true;
  }
  public async subscribe(callback: (message: MessageBase) => void): Promise<void> {
    this.Emitter.on('event', (m: MessageBase) => {
      callback(m);
    });
  }
}
