import { Message, Serialize } from '@spinajs/Queue';
export class UserPropertyChangedMessage extends Message {
  @Serialize()
  public Uuid: string;

  @Serialize()
  public Property: string;

  @Serialize()
  public Value: any;
}
