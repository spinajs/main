import { Autoinject, Injectable, NewInstance } from '@spinajs/di';

import { RouteMiddleware } from '../interfaces.js';
import type { IMiddlewareContext } from '../interfaces.js';
import { BotCheckService } from './service.js';

/** Runs `http.bot.checks.<check>` before the route arguments are extracted. Attach it with `@BotCheck(check)`. */
@Injectable()
@NewInstance()
export class BotCheckMiddleware extends RouteMiddleware {
  @Autoinject(BotCheckService)
  protected Service: BotCheckService;

  constructor(public readonly check: string) {
    super();
  }

  public async onBefore({ req }: IMiddlewareContext): Promise<void> {
    await this.Service.check(this.check, req);
  }
}
