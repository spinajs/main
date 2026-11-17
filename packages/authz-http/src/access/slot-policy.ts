import { AuthzContributor, isPermission, parsePermission } from '@spinajs/authz';
import type { AuthzContribution, Permission, PermissionRefDecl } from '@spinajs/authz';
import { CONFIGURATION_CONTAINER_KEY, Configuration, normalizeEnvironment } from '@spinajs/configuration';
import { Container, DI, SyncService, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy, RouteRegistrationException } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import type { Log } from '@spinajs/log';

import { ACCESS_DESCRIPTOR } from '../api.js';
import type { IAccessDescriptor } from './descriptor.js';
import { AccessPolicy } from './policy.js';

/** The slot value that checks `<module>.auth.permissions.<endpoint>` through authz. */
export const ACCESS_SLOT = 'AccessPolicy';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** The env names development: `configuredEnv` when it is a string, else APP_ENV, else NODE_ENV. A missing env is production. */
export function isExplicitDevelopment(env: EnvLike = process.env, configuredEnv?: unknown): boolean {
  const configured = typeof configuredEnv === 'string' ? configuredEnv : undefined;
  return normalizeEnvironment(configured ?? env.APP_ENV ?? env.NODE_ENV) === 'dev';
}

export interface DevelopmentSkipSettings {
  /** `<module>.auth.skipInDevelopment` */
  readonly skipInDevelopment: unknown;
  /** `configuration.isProduction` */
  readonly isProduction: unknown;
  /** The env the Configuration loaded its files for ({@link configuredEnvOf}). */
  readonly configuredEnv?: unknown;
}

/** The opt-in development skip: the flag is exactly `true`, the env names development, and `isProduction` is not `true`. */
export function skipsAuthInDevelopment(settings: DevelopmentSkipSettings, env: EnvLike = process.env): boolean {
  return settings.skipInDevelopment === true && settings.isProduction !== true && isExplicitDevelopment(env, settings.configuredEnv);
}

/**
 * The env the Configuration that `instance`'s `@Config` properties read loaded its files for. FrameworkConfiguration
 * keeps it (`--env`, else APP_ENV) in `Env`; the tree's `process.env.APP_ENV` is no substitute: it defaults to
 * 'development'.
 */
export function configuredEnvOf(instance: object): unknown {
  const held: unknown = Reflect.get(instance, CONFIGURATION_CONTAINER_KEY);
  const container: IContainer = held instanceof Container ? held : DI.RootContainer;
  const configuration = container.get(Configuration);
  return configuration && 'Env' in configuration ? configuration.Env : undefined;
}

export interface SlotSettings {
  /** `<module>.auth.policies` */
  readonly policies: Readonly<Record<string, string>>;
  /** `<module>.auth.permissions` */
  readonly permissions: Readonly<Record<string, string | readonly string[]>>;
  /** `<module>.auth.domain` */
  readonly domain: string;
  /** `<module>.auth.skipInDevelopment` */
  readonly skipInDevelopment: unknown;
  /** `configuration.isProduction` */
  readonly isProduction: unknown;
}

type Guard = { kind: 'access'; policy: AccessPolicy; permissions: readonly Permission[]; domain: string } | { kind: 'named'; policy: BasePolicy } | { kind: 'skip' };

type Refusal = (why: string) => RouteRegistrationException;

// AccessPolicy reads its rule from the controller's ACCESS_DESCRIPTOR. This rule comes from configuration, so a
// stand-in for the controller carries it.
function ruleHolder(controller: IController, rule: string, permissions: readonly Permission[], domain: string): IController {
  const descriptor: IAccessDescriptor = {
    Access: new Map([[rule, { permissions, options: { domain } }]]),
    Anonymous: new Map(),
    Unscoped: new Map(),
    UnfilteredInput: new Map(),
  };
  const holder: IController = { Router: controller.Router, Descriptor: controller.Descriptor, BasePath: controller.BasePath };
  Reflect.defineMetadata(ACCESS_DESCRIPTOR, descriptor, holder);
  return holder;
}

/**
 * Guards one endpoint by its slot `<module>.auth.policies.<endpoint>`, read when http registers the route:
 * `'AccessPolicy'` checks any of `<module>.auth.permissions.<endpoint>` on the permission's type-level resource in
 * `<module>.auth.domain`; any other value names a registered BasePolicy. A slot that cannot be honoured throws, so
 * the route never registers.
 *
 * A SyncService rather than a BasePolicy subclass: DI calls resolve() only on a service. The subclass declares the
 * logger and the `@Config` properties, so each instance reads the Configuration of the container that resolved it.
 */
export abstract class SlotAccessPolicy extends SyncService implements BasePolicy {
  /** The configuration module (`<module>.auth.*`) and the prefix of every message. */
  protected abstract readonly module: string;

  protected abstract readonly Log: Log;

  protected abstract slotSettings(): SlotSettings;

  private resolvedGuard?: Guard;
  private holder?: IController;

  public constructor(public readonly endpoint: string) {
    super();
  }

  public resolve(): void {
    super.resolve();
    this.resolvedGuard = this.read();
  }

  // An instance built with `new` gets no resolve(); it reads the root Configuration on first use.
  protected get guard(): Guard {
    return (this.resolvedGuard ??= this.read());
  }

  public isEnabled(route: IRoute, controller: IController): boolean {
    const guard = this.guard;
    return guard.kind === 'named' ? guard.policy.isEnabled(route, controller) : true;
  }

  public async execute(req: Request, route: IRoute, controller: IController): Promise<void> {
    const guard = this.guard;
    switch (guard.kind) {
      case 'skip':
        return;
      case 'named':
        return guard.policy.execute(req, route, controller);
      case 'access':
        this.holder ??= ruleHolder(controller, this.module, guard.permissions, guard.domain);
        return guard.policy.execute(req, { ...route, Method: this.module }, this.holder);
    }
  }

  protected read(): Guard {
    const endpoint = this.endpoint;
    const settings = this.slotSettings();
    const slotKey = `${this.module}.auth.policies.${endpoint}`;
    const fail: Refusal = (why) => new RouteRegistrationException(`${this.module} endpoint ${String(endpoint)}: ${why}`);

    if (typeof endpoint !== 'string' || endpoint.length === 0) throw fail('the endpoint name must be a non-empty string');
    const slot = settings.policies[endpoint];
    if (slot === undefined) throw fail(`${slotKey} must name a policy, but it is not set`);
    return slot === ACCESS_SLOT ? this.accessGuard(settings, fail) : { kind: 'named', policy: this.namedPolicy(slot, slotKey, fail) };
  }

  private accessGuard(settings: SlotSettings, fail: Refusal): Guard {
    const endpoint = this.endpoint;
    const raw = settings.permissions[endpoint];
    if (raw === undefined) throw fail(`${this.module}.auth.permissions.${endpoint} must be a permission name or a non-empty list of them, but it is not set`);

    if (skipsAuthInDevelopment({ skipInDevelopment: settings.skipInDevelopment, isProduction: settings.isProduction, configuredEnv: configuredEnvOf(this) })) {
      this.Log.warn({ endpoint }, `${this.module} endpoint \${endpoint}: authorization skipped (${this.module}.auth.skipInDevelopment in a development env)`);
      return { kind: 'skip' };
    }
    return { kind: 'access', policy: new AccessPolicy('route'), permissions: typeof raw === 'string' ? [raw] : raw, domain: settings.domain };
  }

  private namedPolicy(slot: string, slotKey: string, fail: Refusal): BasePolicy {
    if (slot === this.constructor.name) throw fail(`${slotKey} must not name ${slot} itself`);
    const type = DI.checkType(BasePolicy, slot) ? (DI.getRegisteredTypes(BasePolicy) ?? []).find((t): t is Class<BasePolicy> => !isFactory(t) && t.name === slot) : undefined;
    if (!type) throw fail(`${slotKey} names ${slot}, which is not a registered BasePolicy`);

    const policy = DI.resolve(type);
    if (!(policy instanceof BasePolicy)) throw fail(`${slotKey} names ${slot}, which does not resolve synchronously to a BasePolicy`);
    return policy;
  }
}

/**
 * Feeds the permissions of every `'AccessPolicy'` slot to the boot checks of `<module>.auth.domain`, so an
 * unregistered one fails that domain's boot instead of the first request.
 */
export abstract class SlotAccessContributor extends AuthzContributor {
  protected abstract readonly module: string;

  protected abstract slotSettings(): Pick<SlotSettings, 'policies' | 'permissions' | 'domain'>;

  public contribute(domain: string): AuthzContribution {
    const settings = this.slotSettings();
    const permissionRefs: PermissionRefDecl[] = [];
    if (settings.domain !== domain) return { permissionRefs };

    for (const [endpoint, slot] of Object.entries(settings.policies)) {
      if (slot !== ACCESS_SLOT) continue;
      const raw = settings.permissions[endpoint];
      const source = `${this.module}.auth.permissions.${endpoint}`;
      for (const permission of typeof raw === 'string' ? [raw] : (raw ?? [])) {
        if (isPermission(permission)) permissionRefs.push({ permission, type: parsePermission(permission).resource, source });
      }
    }
    return { permissionRefs };
  }
}
