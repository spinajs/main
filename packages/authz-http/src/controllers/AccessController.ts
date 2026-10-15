import { BaseController, BasePath, Body, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';

import { domainService } from '../domains.js';
import { HasPrincipal } from '../access/principal-policies.js';
import { MAX_ACCESS_CHECKS, answerClientChecks } from '../client-access/checks.js';
import '../storage.js';

/** The caller's own access (design §10, §11.4), in the domain `authz.http.access.domain` (default root). */
@BasePath('user/access')
export class AccessController extends BaseController {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Config('authz')
  protected Authz: unknown;

  @Logger('authz-http')
  protected Log: Log;

  @Get('/')
  @Policy(HasPrincipal)
  public async summary(@Req() req: Request) {
    const authz = await domainService(this.AccessDomain);
    return new Ok(await authz.summary(req.storage.Principal!));
  }

  /** ckit's `createHttpChecker` wire format: `{ checks }` → `{ results, reasons }` (design §10.2). */
  @Post('checks')
  @Policy(HasPrincipal)
  public async checks(@Req() req: Request, @Body() checks: unknown[]) {
    if (!Array.isArray(checks) || checks.length > MAX_ACCESS_CHECKS) {
      throw new InvalidArgument(`checks must be a list of at most ${MAX_ACCESS_CHECKS} entries`, 'checks');
    }
    const authz = await domainService(this.AccessDomain);
    return new Ok(await answerClientChecks(authz, req.storage.Principal!, checks, { authz: this.Authz, log: this.Log }));
  }
}
