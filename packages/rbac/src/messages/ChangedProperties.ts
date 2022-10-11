import { QueueMessage, Serialize } from '@spinajs/Queue';
export class UserPropertyChangedMessage extends QueueMessage {
  @Serialize()
  public Uuid: string;

  @Serialize()
  public Property: string;

  @Serialize()
  public Value: any;
}
