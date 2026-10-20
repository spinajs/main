import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketPolicyGate } from '../policies.js';

@Injectable(SocketCommandStage)
export class PoliciesStage extends SocketCommandStage {
  @Autoinject()
  protected Gate: SocketPolicyGate;

  public get Order(): number {
    return STAGE_ORDER.Policies;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    await this.Gate.check(ctx);
    return next();
  }
}
