import { isPermission, parsePermission } from '@spinajs/authz';
import type { Permission, Principal, ResourceRef } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy, Query, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';

import { domainService } from '../domains.js';
import { forbidden, unauthenticated } from '../access/policy.js';
import '../storage.js';

function splitKey(key: unknown, what: string): { type: string; id?: string } {
  if (typeof key !== 'string' || key === '') throw new InvalidArgument(`${what} is required as <type>:<id>`, what);
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

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    const principal = req.storage.Principal;
    if (!principal?.authenticated) throw unauthenticated('the explain route needs an authenticated principal');

    const authz = await domainService(this.AccessDomain);
    const permission = this.ExplainPermission;
    const decision = await authz.check({ principal, permission, resource: { type: parsePermission(permission).resource } });
    // Only an unconditional grant: nothing here would enforce a residual.
    if (!decision.allowed || decision.residual.op !== 'true') throw forbidden(decision);
  }
}

/**
 * `GET /authz/explain?principal=<type>:<id>&permission=&resource=<type>[:<id>]`: the decision with
 * its trace (design §11.4). Mounted only by ExplainControllerSource: when
 * `authz.http.explainRoute.enabled` and never in production (H19, B41).
 */
@BasePath('authz')
export class ExplainController extends BaseController {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Get('explain')
  @Policy(ExplainPolicy)
  public async explain(@Req() _req: Request, @Query() principal: string, @Query() permission: string, @Query() resource?: string) {
    const target = splitKey(principal, 'principal');
    if (target.id === undefined) throw new InvalidArgument('principal must be <type>:<id>', 'principal');
    if (!isPermission(permission)) throw new InvalidArgument('permission must be a permission name', 'permission');
    const ref: ResourceRef = resource === undefined || resource === '' ? { type: parsePermission(permission).resource } : splitKey(resource, 'resource');

    const subject: Principal = Object.freeze({ type: target.type, id: target.id, authenticated: target.type !== 'anonymous' && target.type !== 'unattended', source: 'explain', attributes: Object.freeze({}) });
    const authz = await domainService(this.AccessDomain);
    return new Ok(await authz.explain({ principal: subject, permission, resource: ref }));
  }
}
