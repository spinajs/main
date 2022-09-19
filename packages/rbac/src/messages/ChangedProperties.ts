import { MessageBase, Serialize } from '@spinajs/Queue';
export class UserPropertyChangedMessage extends MessageBase {
  @Serialize()
  public Uuid: string;

  @Serialize()
  public Property: string;

  @Serialize()
  public Value: any;
}
