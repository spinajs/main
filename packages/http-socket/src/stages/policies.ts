import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { SocketPolicyGate } from '../policies.js';

@Injectable(SocketMiddleware)
export class PoliciesStage extends SocketMiddleware {
  @Autoinject()
  protected Gate: SocketPolicyGate;

  public get Order(): number {
    return STAGE_ORDER.Policies;
  }

  public async onBefore(ctx: ISocketCommandContext): Promise<void> {
    await this.Gate.check(ctx);
  }
}
