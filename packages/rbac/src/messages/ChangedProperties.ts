import { QueueMessage } from '@spinajs/queue';
export class UserPropertyChangedMessage extends QueueMessage {
  public Uuid: string;

  public Property: string;

  public Value: any;
}
