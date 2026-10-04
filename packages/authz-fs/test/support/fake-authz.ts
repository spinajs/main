import { AccessDenied, FALSE, TRUE, resourceKey } from '@spinajs/authz';
import type { CheckInput, Decision, Permission, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';

export interface CheckCall {
  readonly kind: 'check' | 'assert';
  readonly principal: string;
  readonly permission: Permission;
  readonly resource: string;
  readonly subject: unknown;
}

/**
 * Records every decision it is asked for; allows what `allow` says ('conditional': allowed with a relation residual
 * left). `speaker` is the principal the decision says the models ran as (the inherit delegate); default the request's.
 */
export class FakeAuthz {
  readonly calls: CheckCall[] = [];

  constructor(
    public allow: (permission: Permission, resource: string) => boolean | 'conditional' = () => true,
    public speaker: (principal: Principal) => PrincipalRef = (p) => ({ type: p.type, id: p.id }),
  ) {}

  async check(req: CheckInput): Promise<Decision> {
    return this.decide('check', req.principal, req.permission, req.resource as ResourceRef, req.subject);
  }

  async assert(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<Decision> {
    const d = this.decide('assert', principal, permission, resource as ResourceRef, subject);
    if (!d.allowed) throw new AccessDenied(d);
    return d;
  }

  keys(): string[] {
    return this.calls.map((c) => `${c.permission} ${c.resource}`);
  }

  private decide(kind: CheckCall['kind'], principal: Principal, permission: Permission, resource: ResourceRef, subject: unknown): Decision {
    const key = resourceKey(resource);
    this.calls.push({ kind, principal: principal.id, permission, resource: key, subject });
    const answer = this.allow(permission, key);
    const allowed = answer !== false;
    const residual = answer === 'conditional' ? { op: 'relation', relation: 'owner' } : allowed ? TRUE : FALSE;
    return { allowed, permission, resource, principal: this.speaker(principal), residual, fields: { read: [], write: [] }, roles: {}, domain: 'root', ...(allowed ? {} : { reason: { code: 'no_access', priority: 900, sortKey: '' } }) } as unknown as Decision;
  }
}
