import type * as express from 'express';
import { Autoinject, Injectable, NewInstance } from '@spinajs/di';

import { RouteMiddleware } from '../interfaces.js';
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

  public isEnabled(): boolean {
    return true;
  }

  public async onBefore(req: express.Request): Promise<void> {
    await this.Service.check(this.check, req);
  }

  public async onResponse(): Promise<void> {}

  public async onAfter(): Promise<void> {}
}
