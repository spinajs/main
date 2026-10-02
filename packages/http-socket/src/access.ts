import { Class, DI, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BasePolicy, IPolicyGroup } from '@spinajs/http';
import { AccessDenied, AuthzDomains, AuthzService, Unauthenticated, parsePermission } from '@spinajs/authz';
import type { Decision, Permission, ResourceRef, ResourceType } from '@spinajs/authz';
import { SocketPolicyGroup } from './decorators.js';
import { ISocketPolicyRequest } from './policies.js';

export type SocketResourceExtractor = (call: ISocketPolicyRequest) => ResourceRef | object | Promise<ResourceRef | object>;

export interface ISocketAccessOptions {
  /** default: the type-level ref of each permission's resource ( `doc:read` → `{ type: 'doc' }` ) */
  resource?: SocketResourceExtractor;
  /** more policies in the same group ( AND ), as authz-http's `AccessOptions.also` ( B23 ) */
  also?: readonly Class<BasePolicy>[];
  /** authz domain; default 'root' */
  domain?: string;
  /** let an unauthenticated principal ( UNATTENDED, anonymous ) reach the engine instead of answering unauthenticated */
  allowAnonymous?: boolean;
}

export interface ISocketAccess extends ISocketAccessOptions {
  permissions: readonly Permission[];
}

/** The resource ref from a payload field ( dotted path ). */
export function fromPayload(path: string, type: ResourceType): SocketResourceExtractor {
  const keys = path.split('.');

  return (call) => {
    let value: unknown = call.body;
    for (const key of keys) {
      value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    }

    if (typeof value === 'number' || (typeof value === 'string' && value.length > 0)) {
      return { type, id: String(value) };
    }

    throw new InvalidArgument(`payload.${path} is required`, path);
  };
}

/**
 * Decides one `@SocketAccess` group as authz-http's AccessPolicy decides `@Access` ( design
 * §11.2 ): unauthenticated ⇒ Unauthenticated, several permissions ⇒ any of them, the allowing
 * decision stays in the call storage, a denial throws AccessDenied.
 */
@NewInstance()
export class SocketAccessPolicy extends BasePolicy {
  constructor(protected readonly access: ISocketAccess) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    const call = req as ISocketPolicyRequest;
    const principal = call.storage.Principal;

    if (!principal.authenticated && !this.access.allowAnonymous) {
      throw new Unauthenticated(`${call.originalUrl} needs an authenticated principal`);
    }

    const authz = await this.service();
    const extracted = this.access.resource ? await this.access.resource(call) : undefined;
    let denied: Decision | undefined;

    for (const permission of this.access.permissions) {
      const decision = await authz.check({ principal, permission, resource: extracted ?? { type: parsePermission(permission).resource } });

      if (decision.allowed) {
        call.storage.AuthzDecision = decision;
        return;
      }

      denied ??= decision;
    }

    throw new AccessDenied(denied!);
  }

  protected async service(): Promise<AuthzService> {
    const domain = this.access.domain ?? 'root';

    if (domain === 'root') {
      return (await DI.resolve(AuthzService)) as AuthzService;
    }

    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    return domains.service(domain);
  }
}

/**
 * The socket form of authz-http's `@Access`, which writes http's controller descriptor and so
 * cannot sit on a socket controller ( D3 ). One group: SocketAccessPolicy AND the `also`
 * policies; other `@SocketPolicy` groups stay alternatives ( OR ).
 */
export function SocketAccess(permission: Permission | readonly Permission[], options: ISocketAccessOptions = {}) {
  const permissions: Permission[] = typeof permission === 'string' ? [permission] : [...permission];

  if (permissions.length === 0) {
    throw new Error('@SocketAccess needs at least one permission');
  }

  // a malformed name fails when the controller module loads, not on the first call
  permissions.forEach((p) => parsePermission(p));

  const access: ISocketAccess = { ...options, permissions };
  return SocketPolicyGroup([{ Type: SocketAccessPolicy, Options: [access] }, ...(options.also ?? []).map((Type) => ({ Type, Options: [] }))] as IPolicyGroup);
}
