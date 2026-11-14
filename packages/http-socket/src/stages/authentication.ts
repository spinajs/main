import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { SocketPrincipalGuard } from '../principal-guard.js';

@Injectable(SocketMiddleware)
export class AuthenticationStage extends SocketMiddleware {
  @Autoinject()
  protected Guard: SocketPrincipalGuard;

  public get Order(): number {
    return STAGE_ORDER.Authentication;
  }

  public async onBefore(ctx: ISocketCommandContext): Promise<void> {
    const connection = ctx.connection;
    await this.Guard.ensure(connection, 'command');

    // the store was built before ensure(), which may have adopted a renewed principal
    ctx.storage.Principal = connection.principal;
    ctx.storage.AuthnPrincipal = connection.authenticated ? connection.principal : null;
  }
}
