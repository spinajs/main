import { BaseController, BasePath, Get, Ok, Policy, Post } from '@spinajs/http';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Autoinject } from '@spinajs/di';
import { AuthzDomains } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

import { AccessDomain } from '../access/domain-arg.js';
import { HasPrincipal, IsAuthenticated } from '../access/principal-policies.js';
import { answerClientChecks } from '../client-access/checks.js';
import { AccessChecks } from '../dto/access-checks.js';
import type { AccessChecksBody } from '../dto/access-checks.js';
import { CurrentPrincipal } from '../principals/current-principal.js';
import { AccessEventStream, SseAccessPushTransport } from '../client-access/sse.js';
import '../storage.js';

/** The caller's own access (design §10, §11.4), in the domain `authz.http.access.domain` (default root). */
@BasePath('user/access')
export class AccessController extends BaseController {
  @Config('authz')
  protected Authz: unknown;

  @Logger('authz-http')
  protected Log: Log;

  @Autoinject(SseAccessPushTransport)
  protected Transport: SseAccessPushTransport;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Get('/')
  @Policy(HasPrincipal)
  public async summary(@CurrentPrincipal() principal: Principal, @AccessDomain() domain: string) {
    const authz = await this.Domains.service(domain);
    return new Ok(await authz.summary(principal));
  }

  /** ckit's `createHttpChecker` wire format: `{ checks }` → `{ results, reasons }` (design §10.2). */
  @Post('checks')
  @Policy(HasPrincipal)
  public async checks(@AccessChecks() checks: AccessChecksBody, @CurrentPrincipal() principal: Principal, @AccessDomain() domain: string) {
    const authz = await this.Domains.service(domain);
    return new Ok(await answerClientChecks(authz, principal, checks, { authz: this.Authz, domains: this.Domains, log: this.Log }));
  }

  /** `authz.changed` server-sent events for the caller (design §10.4); authenticated only, as the socket transport. */
  @Get('events')
  @Policy(IsAuthenticated)
  public async events(@CurrentPrincipal() principal: Principal) {
    return new AccessEventStream(this.Transport, principal);
  }
}
