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
    const connection = ctx.connection;
    await this.Guard.ensure(connection, 'command');

    // the store was built before ensure(), which may have adopted a renewed principal
    ctx.storage.Principal = connection.principal;
    ctx.storage.AuthnPrincipal = connection.authenticated ? connection.principal : null;
    return next();
  }
}
