import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserPropertyChanged extends QueueEvent {
  public Uuid: string;

  public Property: string;

  public OldValue: any;
  public NewValue: any;
}
