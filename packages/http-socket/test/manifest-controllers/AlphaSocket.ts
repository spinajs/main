import { BaseSocketController } from '../../src/controller.js';
import { Command, Payload, SocketController } from '../../src/decorators.js';

@SocketController('mfa')
export class AlphaSocket extends BaseSocketController {
  @Command('add')
  public async add(@Payload() n: number) {
    return n + 1;
  }
}
