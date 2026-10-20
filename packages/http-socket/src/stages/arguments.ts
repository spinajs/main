import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketArgumentResolver } from '../args.js';

@Injectable(SocketCommandStage)
export class ArgumentsStage extends SocketCommandStage {
  @Autoinject()
  protected Arguments: SocketArgumentResolver;

  public get Order(): number {
    return STAGE_ORDER.Arguments;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    ctx.args = await this.Arguments.resolve(ctx);
    return next();
  }
}
