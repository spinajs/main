import { AuthzConfigError, isPermission, parsePermission } from '@spinajs/authz';
import type { Decision, Permission, ResourceRef } from '@spinajs/authz';
import { BaseController, BasePath, Body, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';

import { domainService } from '../domains.js';
import { HasPrincipal, IsAuthenticated } from '../access/principal-policies.js';
import '../storage.js';

export const MAX_ACCESS_CHECKS = 100;

interface AccessCheck {
  readonly permission: Permission;
  readonly resource?: ResourceRef;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function readChecks(raw: unknown): AccessCheck[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ACCESS_CHECKS) {
    throw new InvalidArgument(`checks must be a list of 1 to ${MAX_ACCESS_CHECKS} entries`, 'checks');
  }
  return raw.map((c, i) => {
    if (!isRecord(c) || !isPermission(c.permission)) throw new InvalidArgument(`checks[${i}].permission must be a permission name`, 'checks');
    const r = c.resource;
    if (r === undefined) return { permission: c.permission };
    if (!isRecord(r) || typeof r.type !== 'string' || r.type === '' || (r.id !== undefined && (typeof r.id !== 'string' || r.id === '')) || Object.keys(r).some((k) => k !== 'type' && k !== 'id')) {
      throw new InvalidArgument(`checks[${i}].resource must be { type, id? }`, 'checks');
    }
    return { permission: c.permission, resource: r.id === undefined ? { type: r.type } : { type: r.type, id: r.id as string } };
  });
}

function withoutTrace(d: Decision): Omit<Decision, 'trace'> {
  const { trace: _trace, ...rest } = d;
  return rest;
}

/** The caller's own access (design §11.4, B25), in the domain `authz.http.access.domain` (default root). */
@BasePath('user/access')
export class AccessController extends BaseController {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Get('/')
  @Policy(HasPrincipal)
  public async summary(@Req() req: Request) {
    const authz = await domainService(this.AccessDomain);
    return new Ok(await authz.summary(req.storage.Principal!));
  }

  @Post('check')
  @Policy(IsAuthenticated)
  public async check(@Req() req: Request, @Body() checks: unknown[]) {
    const list = readChecks(checks);
    const authz = await domainService(this.AccessDomain);
    const principal = req.storage.Principal!;
    const decisions: Omit<Decision, 'trace'>[] = [];

    for (const c of list) {
      try {
        decisions.push(withoutTrace(await authz.check({ principal, permission: c.permission, resource: c.resource ?? { type: parsePermission(c.permission).resource } })));
      } catch (err) {
        if (err instanceof AuthzConfigError) throw new InvalidArgument(`cannot check ${c.permission}: ${err.message}`, 'checks');
        throw err;
      }
    }

    return new Ok({ decisions });
  }
}
