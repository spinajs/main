import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { SocketArgumentResolver } from '../args.js';

@Injectable(SocketMiddleware)
export class ArgumentsStage extends SocketMiddleware {
  @Autoinject()
  protected Arguments: SocketArgumentResolver;

  public get Order(): number {
    return STAGE_ORDER.Arguments;
  }

  public async onBefore(ctx: ISocketCommandContext): Promise<void> {
    ctx.args = await this.Arguments.resolve(ctx);
  }
}
