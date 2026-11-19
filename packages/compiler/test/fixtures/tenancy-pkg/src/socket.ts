import { BaseSocketController, Command, SocketController } from '@spinajs/http-socket';

@SocketController('billing')
export class BillingSocket extends BaseSocketController {
  @Command('totals')
  public async totals(): Promise<void> {}
}
