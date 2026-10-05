import { DI, Injectable, NewInstance, isFactory } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthzContributor, isPermission, parsePermission } from '@spinajs/authz';
import type { AuthzContribution, Permission, PermissionRefDecl } from '@spinajs/authz';
import { ACCESS_DESCRIPTOR, AccessPolicy } from '@spinajs/authz-http';
import type { IAccessDescriptor } from '@spinajs/authz-http';
import { BasePolicy, Policy, RouteRegistrationException } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { telemetrySkipsAuth } from './development.js';

/** The slot value that checks `telemetry.auth.permissions.<endpoint>` through authz. */
export const TELEMETRY_ACCESS_SLOT = 'AccessPolicy';

const RULE = 'telemetry';

class TelemetryAccessRule {}

// AccessPolicy reads its rule from the controller's ACCESS_DESCRIPTOR. This rule comes from
// configuration, not from an @Access decorator, so a holder carries the descriptor instead.
function ruleHolder(permissions: readonly Permission[], domain: string): IController {
  const descriptor: IAccessDescriptor = {
    Access: new Map([[RULE, { permissions, options: { domain } }]]),
    Anonymous: new Map(),
    Unscoped: new Map(),
    UnfilteredInput: new Map(),
  };
  const holder = new TelemetryAccessRule();
  Reflect.defineMetadata(ACCESS_DESCRIPTOR, descriptor, holder);
  return holder as unknown as IController;
}

type Guard = { kind: 'access'; policy: AccessPolicy; holder: IController } | { kind: 'named'; policy: BasePolicy } | { kind: 'skip' };

/**
 * Guards one telemetry endpoint by its slot `telemetry.auth.policies.<endpoint>`, read once when
 * http registers the route: `'AccessPolicy'` checks any of `telemetry.auth.permissions.<endpoint>`
 * on the permission's type-level resource in `telemetry.auth.domain` (default root), with
 * AccessPolicy's 401/403 answers; any other value names a registered BasePolicy that decides
 * instead. A slot that cannot be honoured throws, so the route never registers.
 */
@NewInstance()
export class TelemetryAccessPolicy extends BasePolicy {
  @Logger('Security')
  protected Log: Log;

  protected readonly guard: Guard;

  constructor(public readonly endpoint: string) {
    super();
    this.guard = this.read();
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
    const slotKey = `telemetry.auth.policies.${endpoint}`;
    const fail = (why: string) => new RouteRegistrationException(`telemetry endpoint ${String(endpoint)}: ${why}`);

    if (typeof endpoint !== 'string' || endpoint.length === 0) throw fail('the endpoint name must be a non-empty string');
    const cfg = DI.get(Configuration);
    if (!cfg) throw fail('no Configuration is registered');

    const slot = cfg.get<unknown>(['telemetry', 'auth', 'policies', endpoint]);
    if (typeof slot !== 'string' || slot.length === 0) throw fail(`${slotKey} must name a policy, got ${JSON.stringify(slot)}`);

    if (slot === TELEMETRY_ACCESS_SLOT) {
      const permissionsKey = `telemetry.auth.permissions.${endpoint}`;
      const raw = cfg.get<unknown>(['telemetry', 'auth', 'permissions', endpoint]);
      const permissions = typeof raw === 'string' ? [raw] : raw;
      if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every(isPermission)) {
        throw fail(`${permissionsKey} must be a permission name or a non-empty list of them, got ${JSON.stringify(raw)}`);
      }

      const domain = cfg.get<unknown>(['telemetry', 'auth', 'domain']) ?? 'root';
      if (typeof domain !== 'string' || domain.length === 0) throw fail(`telemetry.auth.domain must be a non-empty string, got ${JSON.stringify(domain)}`);

      if (telemetrySkipsAuth()) {
        this.Log.warn(`telemetry endpoint ${endpoint}: authorization skipped (telemetry.auth.skipInDevelopment in a development env)`);
        return { kind: 'skip' };
      }
      return { kind: 'access', policy: new AccessPolicy('route'), holder: ruleHolder(permissions, domain) };
    }

    if (slot === TelemetryAccessPolicy.name) throw fail(`${slotKey} must not name TelemetryAccessPolicy itself`);
    const type = DI.checkType(BasePolicy, slot) ? (DI.getRegisteredTypes(BasePolicy) ?? []).find((t): t is Class<BasePolicy> => !isFactory(t) && t.name === slot) : undefined;
    if (!type) throw fail(`${slotKey} names ${slot}, which is not a registered BasePolicy`);

    const policy = DI.resolve(type);
    if (!(policy instanceof BasePolicy)) throw fail(`${slotKey} names ${slot}, which does not resolve synchronously to a BasePolicy`);
    return { kind: 'named', policy };
  }
}

/** Guards a route by the telemetry slot `telemetry.auth.policies.<endpoint>`. */
export function TelemetryAccess(endpoint: string) {
  return Policy(TelemetryAccessPolicy, endpoint);
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Feeds the permissions of every `'AccessPolicy'` slot to boot rule 7 of `telemetry.auth.domain`
 * (default root), so an unregistered one fails that domain's boot (B02) instead of the first request.
 * Malformed values emit nothing: TelemetryAccessPolicy refuses them when the route registers.
 */
@Injectable(AuthzContributor)
export class TelemetryAccessContributor extends AuthzContributor {
  public contribute(domain: string): AuthzContribution {
    const permissionRefs: PermissionRefDecl[] = [];
    const cfg = DI.get(Configuration);
    if (!cfg || (cfg.get<unknown>(['telemetry', 'auth', 'domain']) ?? 'root') !== domain) return { permissionRefs };

    const slots = cfg.get<unknown>(['telemetry', 'auth', 'policies']);
    if (!isRecord(slots)) return { permissionRefs };

    for (const [endpoint, slot] of Object.entries(slots)) {
      if (slot !== TELEMETRY_ACCESS_SLOT) continue;
      const raw = cfg.get<unknown>(['telemetry', 'auth', 'permissions', endpoint]);
      const source = `telemetry.auth.permissions.${endpoint}`;
      for (const permission of typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []) {
        if (isPermission(permission)) permissionRefs.push({ permission, type: parsePermission(permission).resource, source });
      }
    }
    return { permissionRefs };
  }
}
