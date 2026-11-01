import { BaseSocketController, Command, Payload, SocketController } from '@spinajs/http-socket';

@SocketController('unexported')
class UnexportedSocket extends BaseSocketController {
  @Command('ping')
  public async ping(@Payload() payload: { text: string }): Promise<{ text: string }> {
    return payload;
  }
}

void UnexportedSocket;
