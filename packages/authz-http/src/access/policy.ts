import { DI, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AccessDenied, AuthzConfigError, AuthzDomains, FALSE, ResourceAdapter, Unauthenticated, authzStorage, isProduction, parsePermission, DefaultAuthzDomains } from '@spinajs/authz';
import type { AuthzService, Decision, DenyReason, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

import { domainConfig, domainService } from '../domains.js';
import { routeAccess, routeDomain } from './descriptor.js';
import { isUnloadedModel } from './extractors.js';
import type { IAccessRule } from './descriptor.js';
import '../storage.js';

export type AccessScope = 'route' | 'class';

/** 401 body: `{ error: 'unauthenticated', message }`. */
export function unauthenticated(message: string): Unauthenticated {
  return Object.assign(new Unauthenticated(message), { error: 'unauthenticated' });
}

/** The reason as the 403 body shows it: its payload without the ordering keys (design §11.2). */
export function publicReason(reason: DenyReason | undefined): Omit<DenyReason, 'priority' | 'sortKey'> | undefined {
  if (!reason) return undefined;
  const { priority: _priority, sortKey: _sortKey, ...rest } = reason;
  return rest;
}

/** AccessDenied whose enumerable props are the 403 body `{ error, permission, resource, reason, trace? }`; http spreads them into the response. */
export function forbidden(decision: Decision, trace?: unknown): AccessDenied {
  const body: Record<string, unknown> = { error: 'forbidden', permission: decision.permission, resource: decision.resource };
  const reason = publicReason(decision.reason);
  if (reason) body.reason = reason;
  if (trace !== undefined) body.trace = trace;
  return Object.assign(new AccessDenied(decision), body);
}

const isRef = (v: unknown): v is ResourceRef => typeof v === 'object' && v !== null && typeof (v as ResourceRef).type === 'string' && Object.keys(v).every((k) => k === 'type' || k === 'id');

/**
 * Decides the `@Access` of its scope (design §11.2), read from the controller's descriptor at
 * request time: a request without a principal, or with an unauthenticated one on a route without
 * `@AllowAnonymous`, is refused 401; several permissions mean any of them; a denial throws a 403
 * with `{ error, permission, resource, reason }`. With `subject: 'load'` a conditional allow is
 * settled against the row the domain's adapter loads. The allowing decision of the route's own
 * `@Access` (else the class's) goes to `req.storage.AuthzDecision`.
 */
@NewInstance()
export class AccessPolicy extends BasePolicy {
  @Config('authz.http.explainRoute.permission')
  protected ExplainPermission: Permission;

  @Config('authz')
  protected Authz: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: boolean | undefined;

  constructor(public readonly scope: AccessScope) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request, route: IRoute, controller: IController): Promise<void> {
    const access = routeAccess(controller, route.Method);
    const rule = this.scope === 'route' ? access.route : access.controller;
    if (!rule) {
      throw new AuthzConfigError(`AccessPolicy on ${controller.constructor.name}.${String(route.Method)} finds no ${this.scope} @Access`);
    }

    req.storage.AuthzHttpRoute = { domain: routeDomain(access), ...(access.unfilteredInput !== undefined ? { unfilteredInput: access.unfilteredInput } : {}) };

    const principal = req.storage.Principal;
    if (!principal) {
      throw unauthenticated('this route needs a principal');
    }
    if (!principal.authenticated && !access.anonymous) {
      throw unauthenticated('this route needs an authenticated principal');
    }

    const domain = rule.options.domain ?? 'root';
    const authz = await domainService(domain);
    const extracted = rule.options.resource ? await rule.options.resource(req) : undefined;
    if (rule.options.resource && (extracted === null || extracted === undefined)) {
      throw new InvalidArgument(`the resource extractor of ${controller.constructor.name}.${String(route.Method)} found no resource`, 'resource');
    }
    const resource = isUnloadedModel(extracted) ? await this.refOf(domain, extracted) : extracted;
    const decision = await this.inStore(req, () => this.decide(authz, domain, rule, principal, resource));

    if (!decision.allowed) {
      throw forbidden(decision, await this.inStore(req, () => this.trace(authz, domain, principal, decision)));
    }
    if (rule === (access.route ?? access.controller)) {
      req.storage.AuthzDecision = decision;
    }
  }

  /** In the request's store, so the checks share its per-request cache with the action's. */
  protected inStore<T>(req: Request, fn: () => Promise<T>): Promise<T> {
    return authzStorage().run(req.storage as unknown as Record<string, unknown>, fn);
  }

  protected async decide(authz: AuthzService, domain: string, rule: IAccessRule, principal: Principal, resource: ResourceRef | object | undefined): Promise<Decision> {
    let denied: Decision | undefined;
    let subject: Promise<unknown> | undefined;

    for (const permission of rule.permissions) {
      let decision = await authz.check({ principal, permission, resource: resource ?? { type: parsePermission(permission).resource } });

      if (decision.allowed && decision.residual.op !== 'true' && rule.options.subject === 'load') {
        subject ??= this.load(domain, decision.resource);
        const row = await subject;
        decision = row === null ? Object.freeze({ ...decision, allowed: false, residual: FALSE, reason: { code: 'unknown_resource' } }) : await authz.check({ principal, permission, resource: decision.resource, subject: row });
      }

      if (decision.allowed) {
        return decision;
      }
      denied ??= decision;
    }

    return denied!;
  }

  /**
   * The ref the domain's adapter gives an unloaded `fromModel` instance. The instance itself must not
   * reach the engine, which would read its default field values as the row.
   */
  protected async refOf(domain: string, instance: object): Promise<ResourceRef> {
    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    const adapters = [...(await domains.container(domain).resolve(Array.chainOf(ResourceAdapter)))] as ResourceAdapter[];
    const adapter = adapters.find((a) => a.accepts(instance));
    if (!adapter) throw new AuthzConfigError(`no ResourceAdapter of domain ${domain} accepts ${instance.constructor.name}`);
    return adapter.refOf(instance);
  }

  /** The row of `ref` from the first adapter of the domain that serves its type and can load; null when none can or the row is missing. */
  protected async load(domain: string, ref: ResourceRef): Promise<unknown> {
    if (!isRef(ref) || ref.id === undefined) return null;
    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    const adapters = [...(await domains.container(domain).resolve(Array.chainOf(ResourceAdapter)))] as ResourceAdapter[];
    const adapter = adapters.find((a) => typeof a.load === 'function' && a.types.includes(ref.type));
    return adapter ? ((await adapter.load!(ref)) ?? null) : null;
  }

  /**
   * The trace of a denial, outside production only, while the domain's `engine.explain` is on and
   * the caller holds the explain permission (`authz.http.explainRoute.permission`, B23, B41).
   */
  protected async trace(authz: AuthzService, domain: string, principal: Principal, denied: Decision): Promise<unknown> {
    if (isProduction(this.IsProduction)) return undefined;

    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    if (!(domains instanceof DefaultAuthzDomains)) return undefined;
    if (!domainConfig(this.Authz, domains, domain).engine.explain) return undefined;

    const permission = this.ExplainPermission;
    // Only an unconditional grant: a residual on the explain permission would not be enforced here.
    const held = await authz.check({ principal, permission, resource: { type: parsePermission(permission).resource } }).catch(() => undefined);
    if (!held?.allowed || held.residual.op !== 'true') return undefined;

    return (await authz.explain({ principal, permission: denied.permission, resource: denied.resource })).trace;
  }
}
