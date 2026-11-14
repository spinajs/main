import { AuthzDomains } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';

import { AccessDomain } from '../access/domain-arg.js';
import { resolveAuthzDomain } from '../access/domain-resolver.js';
import { ExplainQueryArg } from '../dto/explain-query.js';
import { forbidden, holdsExplain, unauthenticated } from '../access/policy.js';
import { resolveExplainRequest } from './resolve.js';
import { explainTree } from './tree.js';
import { AuthzHttpRateLimit } from '../rate-limit/index.js';
import '../storage.js';

/** Allows a caller who holds `authz.http.explainRoute.permission` in the access domain. */
export class ExplainPolicy extends BasePolicy {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Config('authz.http.explainRoute.permission')
  protected ExplainPermission: Permission;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    const principal = req.storage.Principal;
    if (!principal?.authenticated) throw unauthenticated('the explain route needs an authenticated principal');

    const { held, decision } = await holdsExplain(await this.Domains.service(await resolveAuthzDomain(req, this.AccessDomain)), principal, this.ExplainPermission);
    if (!held) throw forbidden(decision);
  }
}

/**
 * `GET /authz/explain?principal=<type>:<id>&permission=&resource=<type>[:<id>]&format=decision|tree`: the decision with
 * its trace (design §11.4). Mounted only by ExplainControllerSource: when
 * `authz.http.explainRoute.enabled` and never in production (H19, B41).
 */
@BasePath('authz')
export class ExplainController extends BaseController {
  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Get('explain')
  @AuthzHttpRateLimit('explain')
  @Policy(ExplainPolicy)
  public async explain(@AccessDomain() domain: string, @ExplainQueryArg('principal') principal: string, @ExplainQueryArg('permission') permission: string, @ExplainQueryArg('resource') resource?: string, @ExplainQueryArg('format') format?: string) {
    const authz = await this.Domains.service(domain);
    const decision = await authz.explain(resolveExplainRequest({ principal, permission, resource }));
    return new Ok(format === 'tree' ? explainTree(decision) : decision);
  }
}
