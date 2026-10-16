import { BaseController, BasePath, Body, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { DI } from '@spinajs/di';
import { _check_arg, _is_array, _max_length } from '@spinajs/util';

import { domainService } from '../domains.js';
import { HasPrincipal, IsAuthenticated } from '../access/principal-policies.js';
import { MAX_ACCESS_CHECKS, answerClientChecks } from '../client-access/checks.js';
import { AccessEventStream, SseAccessPushTransport } from '../client-access/sse.js';
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
    _check_arg(_is_array(), _max_length(MAX_ACCESS_CHECKS))(checks, 'checks');
    const authz = await domainService(this.AccessDomain);
    return new Ok(await answerClientChecks(authz, req.storage.Principal!, checks, { authz: this.Authz, log: this.Log }));
  }

  /** `authz.changed` server-sent events for the caller (design §10.4); authenticated only, as the socket transport. */
  @Get('events')
  @Policy(IsAuthenticated)
  public async events(@Req() req: Request) {
    const transport = (await DI.resolve(SseAccessPushTransport)) as SseAccessPushTransport;
    return new AccessEventStream(transport, req.storage.Principal!);
  }
}
