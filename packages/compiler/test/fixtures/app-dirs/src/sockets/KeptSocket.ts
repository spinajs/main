import { BaseSocketController, Command, Payload, SocketController } from '@spinajs/http-socket';

@SocketController('kept')
export class KeptSocket extends BaseSocketController {
  @Command('ping')
  public async ping(@Payload() payload: { text: string }): Promise<{ text: string }> {
    return payload;
  }
}
