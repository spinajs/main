import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketPrincipalGuard } from '../principal-guard.js';

@Injectable(SocketCommandStage)
export class AuthenticationStage extends SocketCommandStage {
  @Autoinject()
  protected Guard: SocketPrincipalGuard;

  public get Order(): number {
    return STAGE_ORDER.Authentication;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    await this.Guard.ensure(ctx.connection);
    return next();
  }
}
