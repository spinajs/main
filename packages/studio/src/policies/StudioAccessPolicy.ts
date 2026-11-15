import { DI, Injectable, NewInstance, Singleton, SyncService, isFactory } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthzContributor, isPermission, parsePermission } from '@spinajs/authz';
import type { AuthzContribution, Permission, PermissionRefDecl } from '@spinajs/authz';
import { ACCESS_DESCRIPTOR, AccessPolicy } from '@spinajs/authz-http';
import type { IAccessDescriptor } from '@spinajs/authz-http';
import { BasePolicy, Policy, RouteRegistrationException } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { configuredEnvOf, studioSkipsAuth } from '../development.js';

/** The slot value that checks `studio.auth.permissions.<endpoint>` through authz. */
export const STUDIO_ACCESS_SLOT = 'AccessPolicy';

const RULE = 'studio';

class StudioAccessRule {}

// AccessPolicy reads its rule from the controller's ACCESS_DESCRIPTOR; this rule comes from configuration, so a holder carries it.
function ruleHolder(permissions: readonly Permission[], domain: string): IController {
  const descriptor: IAccessDescriptor = {
    Access: new Map([[RULE, { permissions, options: { domain } }]]),
    Anonymous: new Map(),
    Unscoped: new Map(),
    UnfilteredInput: new Map(),
  };
  const holder = new StudioAccessRule();
  Reflect.defineMetadata(ACCESS_DESCRIPTOR, descriptor, holder);
  return holder as unknown as IController;
}

type Guard = { kind: 'access'; policy: AccessPolicy; holder: IController } | { kind: 'named'; policy: BasePolicy } | { kind: 'skip' };

/**
 * Guards one Studio endpoint by its slot `studio.auth.policies.<endpoint>`, read when http registers the route:
 * `'AccessPolicy'` checks any of `studio.auth.permissions.<endpoint>` on the permission's type-level resource in
 * `studio.auth.domain`; any other value names a registered BasePolicy. A slot that cannot be honoured throws, so
 * the route never registers.
 *
 * A SyncService rather than a BasePolicy subclass: DI calls resolve() only on a service.
 */
@NewInstance()
export class StudioAccessPolicy extends SyncService implements BasePolicy {
  @Logger('Security')
  protected Log: Log;

  @Config('studio.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('studio.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('studio.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('studio.auth.skipInDevelopment')
  protected SkipInDevelopment: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: unknown;

  private resolvedGuard?: Guard;

  public constructor(public readonly endpoint: string) {
    super();
  }

  public resolve(): void {
    super.resolve();
    this.resolvedGuard = this.read();
  }

  protected get guard(): Guard {
    return (this.resolvedGuard ??= this.read());
  }

  public isEnabled(route: IRoute, controller: IController): boolean {
    return this.guard.kind === 'named' ? this.guard.policy.isEnabled(route, controller) : true;
  }

  public async execute(req: Request, route: IRoute, controller: IController): Promise<void> {
    switch (this.guard.kind) {
      case 'skip':
        return;
      case 'named':
        return this.guard.policy.execute(req, route, controller);
      case 'access':
        return this.guard.policy.execute(req, { ...route, Method: RULE }, this.guard.holder);
    }
  }

  protected read(): Guard {
    const endpoint = this.endpoint;
    const slotKey = `studio.auth.policies.${endpoint}`;
    const fail = (why: string) => new RouteRegistrationException(`studio endpoint ${String(endpoint)}: ${why}`);

    if (typeof endpoint !== 'string' || endpoint.length === 0) throw fail('the endpoint name must be a non-empty string');
    const slot = this.Policies[endpoint];
    if (slot === undefined) throw fail(`${slotKey} must name a policy, but it is not set`);

    if (slot === STUDIO_ACCESS_SLOT) {
      const permissionsKey = `studio.auth.permissions.${endpoint}`;
      const raw = this.Permissions[endpoint];
      if (raw === undefined) throw fail(`${permissionsKey} must be a permission name or a non-empty list of them, but it is not set`);
      const permissions = (typeof raw === 'string' ? [raw] : raw);

      if (studioSkipsAuth({ skipInDevelopment: this.SkipInDevelopment, isProduction: this.IsProduction, configuredEnv: configuredEnvOf(this) })) {
        this.Log.warn({ endpoint }, 'studio endpoint ${endpoint}: authorization skipped (studio.auth.skipInDevelopment in a development env)');
        return { kind: 'skip' };
      }
      return { kind: 'access', policy: new AccessPolicy('route'), holder: ruleHolder(permissions, this.Domain) };
    }

    if (slot === StudioAccessPolicy.name) throw fail(`${slotKey} must not name StudioAccessPolicy itself`);
    const type = DI.checkType(BasePolicy, slot) ? (DI.getRegisteredTypes(BasePolicy) ?? []).find((t): t is Class<BasePolicy> => !isFactory(t) && t.name === slot) : undefined;
    if (!type) throw fail(`${slotKey} names ${slot}, which is not a registered BasePolicy`);

    const policy = DI.resolve(type);
    if (!(policy instanceof BasePolicy)) throw fail(`${slotKey} names ${slot}, which does not resolve synchronously to a BasePolicy`);
    return { kind: 'named', policy };
  }
}

/** Guards a route by the Studio slot `studio.auth.policies.<endpoint>`. */
export function StudioAccess(endpoint: string) {
  return Policy(StudioAccessPolicy, endpoint);
}

/**
 * Feeds the permissions of every `'AccessPolicy'` slot to the boot checks of `studio.auth.domain`, so an
 * unregistered one fails that domain's boot instead of the first request.
 */
@Injectable(AuthzContributor)
@Singleton()
export class StudioAccessContributor extends AuthzContributor {
  @Config('studio.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('studio.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('studio.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  public contribute(domain: string): AuthzContribution {
    const permissionRefs: PermissionRefDecl[] = [];
    if (this.Domain !== domain) return { permissionRefs };

    for (const [endpoint, slot] of Object.entries(this.Policies)) {
      if (slot !== STUDIO_ACCESS_SLOT) continue;
      const raw = this.Permissions[endpoint];
      const source = `studio.auth.permissions.${endpoint}`;
      for (const permission of typeof raw === 'string' ? [raw] : (raw ?? [])) {
        if (isPermission(permission)) permissionRefs.push({ permission, type: parsePermission(permission).resource, source });
      }
    }
    return { permissionRefs };
  }
}
