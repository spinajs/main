import { AuthzDomains, parsePermission } from '@spinajs/authz';
import type { Permission, Principal, ResourceRef } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';

import { AccessDomain } from '../access/domain-arg.js';
import { resolveAuthzDomain } from '../access/domain-resolver.js';
import { ExplainQueryArg } from '../dto/explain-query.js';
import { forbidden, holdsExplain, unauthenticated } from '../access/policy.js';
import { explainTree } from './tree.js';
import '../storage.js';

function splitKey(raw: unknown, what: string): { type: string; id?: string } {
  const key: string = _check_arg(_is_string(_non_empty()))(raw, what);
  const at = key.indexOf(':');
  const rawType = at < 0 ? key : key.slice(0, at);
  const id = at < 0 ? undefined : key.slice(at + 1);
  // principalKey escapes '%' and ':' in the type part only.
  const type = rawType.replace(/%3A/gi, ':').replace(/%25/g, '%');
  if (type === '' || id === '') throw new InvalidArgument(`${what} must be <type>:<id>`, what);
  return id === undefined ? { type } : { type, id };
}

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
  public static readonly mountedBySource = true;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Get('explain')
  @Policy(ExplainPolicy)
  public async explain(@AccessDomain() domain: string, @ExplainQueryArg('principal') principal: string, @ExplainQueryArg('permission') permission: string, @ExplainQueryArg('resource') resource?: string, @ExplainQueryArg('format') format?: string) {
    const target = splitKey(principal, 'principal');
    if (target.id === undefined) throw new InvalidArgument('principal must be <type>:<id>', 'principal');
    const ref: ResourceRef = resource === undefined || resource === '' ? { type: parsePermission(permission).resource } : splitKey(resource, 'resource');

    const subject: Principal = Object.freeze({ type: target.type, id: target.id, authenticated: target.type !== 'anonymous' && target.type !== 'unattended', source: 'explain', attributes: Object.freeze({}) });
    const authz = await this.Domains.service(domain);
    const decision = await authz.explain({ principal: subject, permission, resource: ref });
    return new Ok(format === 'tree' ? explainTree(decision) : decision);
  }
}
