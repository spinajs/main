import { Class, DI, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BasePolicy, IPolicyGroup } from '@spinajs/http';
import type { IController, IRoute } from '@spinajs/http';
import { AccessDenied, AuthzDomains, AuthzService, FALSE, ResourceAdapter, Unauthenticated, parsePermission } from '@spinajs/authz';
import type { Decision, Permission, Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import { BaseSocketController } from './controller.js';
import { SocketPolicyGroup } from './decorators.js';
import { ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from './interfaces.js';
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
  /** 'load': a conditional allow is checked again against the row the domain's ResourceAdapter loads, so the answer is definite */
  subject?: 'load' | 'none';
  /** 'filter': the result, or each chunk of a stream reply, keeps only the fields `decision.fields.read` allows, minus the domain's `fields.neverRead` */
  fields?: 'filter' | 'none';
  /** why the payload skips authz-http's input field filter, as `@UnfilteredInput(reason)` */
  unfilteredInput?: string;
}

export interface ISocketAccess extends ISocketAccessOptions {
  permissions: readonly Permission[];
  /** where `@SocketAccess` sits; the handler's own rule, else the class's, leaves its decision in the call storage */
  scope: 'handler' | 'class';
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

/** The first `@SocketAccess` rule among one scope's policy groups ( a handler's, or its controller's ). */
export function socketAccessOf(groups: readonly IPolicyGroup[] | undefined): ISocketAccess | undefined {
  for (const member of (groups ?? []).flat()) {
    if (member.Type === SocketAccessPolicy) {
      return member.Options[0] as ISocketAccess;
    }
  }

  return undefined;
}

/** The domain of a call's input mark and output filter: the handler rule's, else the class rule's, else root, as authz-http's `routeDomain`. */
export function socketAccessDomain(handler: readonly IPolicyGroup[] | undefined, controller: readonly IPolicyGroup[] | undefined): string {
  return socketAccessOf(handler)?.domain ?? socketAccessOf(controller)?.domain ?? 'root';
}

const isRef =(v: unknown): v is ResourceRef => typeof v === 'object' && v !== null && typeof (v as ResourceRef).type === 'string' && Object.keys(v).every((k) => k === 'type' || k === 'id');

/**
 * Decides one `@SocketAccess` group as authz-http's AccessPolicy decides `@Access` ( design §11.2 ): unauthenticated ⇒
 * Unauthenticated, an extractor that finds nothing ⇒ InvalidArgument, several permissions ⇒ any of them, `subject: 'load'` ⇒
 * a conditional allow settled against the loaded row, a denial ⇒ AccessDenied, never with a trace ( sockets offer no explain ).
 * The allowing decision of the handler's own rule, else the class's, stays in the call storage.
 */
@NewInstance()
export class SocketAccessPolicy extends BasePolicy {
  constructor(protected readonly access: ISocketAccess) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  /**
   * @param route - the socket gate's route: its `Policies` are the handler's own groups
   * @param controller - the socket controller: its `Descriptor.Policies` are the class's groups
   */
  public async execute(req: unknown, route?: IRoute, controller?: IController): Promise<void> {
    const call = req as ISocketPolicyRequest;
    const domain = this.access.domain ?? 'root';
    const deciding = this.access.scope === 'handler' || socketAccessOf(route?.Policies) === undefined;

    if (deciding) {
      // authz-http's AuthzInputFieldFilter reads this mark, so a call another policy group admitted still loses fields.neverRead
      const marked = socketAccessDomain(route?.Policies, (controller as BaseSocketController | undefined)?.Descriptor?.Policies);
      call.storage.AuthzHttpRoute = { domain: marked, ...(this.access.unfilteredInput !== undefined ? { unfilteredInput: this.access.unfilteredInput } : {}) };
      // the filter reads AuthzDomains with DI.get: while nothing resolved it, a configured write mode 'reject' would silently strip
      await DI.resolve(AuthzDomains);
    }

    const principal = call.storage.Principal;
    if (!principal.authenticated && !this.access.allowAnonymous) {
      throw new Unauthenticated(`${call.originalUrl} needs an authenticated principal`);
    }

    const authz = await this.service(domain);
    const resource = this.access.resource ? await this.access.resource(call) : undefined;
    if (this.access.resource && (resource === null || resource === undefined)) {
      throw new InvalidArgument(`the resource extractor of ${call.originalUrl} found no resource`, 'resource');
    }

    const decision = await this.decide(authz, domain, principal, resource);
    if (!decision.allowed) {
      throw new AccessDenied(decision);
    }

    if (deciding) {
      call.storage.AuthzDecision = decision;
    }
  }

  protected async decide(authz: AuthzService, domain: string, principal: Principal, resource: ResourceRef | object | undefined): Promise<Decision> {
    let denied: Decision | undefined;
    let row: Promise<unknown> | undefined;

    for (const permission of this.access.permissions) {
      let decision = await authz.check({ principal, permission, resource: resource ?? { type: parsePermission(permission).resource } });

      if (decision.allowed && decision.residual.op !== 'true' && this.access.subject === 'load') {
        row ??= this.load(domain, decision.resource);
        const subject = await row;
        decision = subject === null ? Object.freeze({ ...decision, allowed: false, residual: FALSE, reason: { code: 'unknown_resource' } }) : await authz.check({ principal, permission, resource: decision.resource, subject });
      }

      if (decision.allowed) {
        return decision;
      }

      denied ??= decision;
    }

    return denied!;
  }

  /** The row from the first adapter of the domain that serves the ref's type and can load; null when none can or the row is missing. */
  protected async load(domain: string, ref: ResourceRef): Promise<unknown> {
    if (!isRef(ref) || ref.id === undefined) {
      return null;
    }

    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    const adapters = [...(await domains.container(domain).resolve(Array.chainOf(ResourceAdapter)))] as ResourceAdapter[];
    const adapter = adapters.find((a) => typeof a.load === 'function' && a.types.includes(ref.type));
    return adapter ? (await adapter.load!(ref)) ?? null : null;
  }

  protected async service(domain: string): Promise<AuthzService> {
    if (domain === 'root') {
      return (await DI.resolve(AuthzService)) as AuthzService;
    }

    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    return domains.service(domain);
  }
}

const CLASS_PLACE = Symbol('class');

// Places each class declared itself, to tell a second @SocketAccess on one place from an override of an inherited one.
const declared = new WeakMap<object, Set<string | symbol>>();

/**
 * The socket form of authz-http's `@Access`, which writes http's controller descriptor and so
 * cannot sit on a socket controller ( D3 ). One group: SocketAccessPolicy AND the `also`
 * policies; other `@SocketPolicy` groups stay alternatives ( OR ). Declared once per handler
 * or class; on a subclass it replaces the inherited `@SocketAccess` group of that place.
 */
export function SocketAccess(permission: Permission | readonly Permission[], options: ISocketAccessOptions = {}) {
  const permissions: Permission[] = typeof permission === 'string' ? [permission] : [...permission];

  if (permissions.length === 0) {
    throw new Error('@SocketAccess needs at least one permission');
  }

  // a malformed name fails when the controller module loads, not on the first call
  permissions.forEach((p) => parsePermission(p));

  if (options.unfilteredInput !== undefined && (typeof options.unfilteredInput !== 'string' || options.unfilteredInput.trim() === '')) {
    throw new Error('@SocketAccess unfilteredInput needs a reason');
  }

  return (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor): void => {
    const owner = target.prototype ?? target;
    const places = declared.get(owner) ?? new Set<string | symbol>();
    if (places.has(propertyKey ?? CLASS_PLACE)) {
      throw new Error(`@SocketAccess is declared twice on ${owner.constructor.name}${propertyKey === undefined ? '' : `.${String(propertyKey)}`}`);
    }
    declared.set(owner, places.add(propertyKey ?? CLASS_PLACE));

    const access: ISocketAccess = { ...options, permissions, scope: propertyKey === undefined ? 'class' : 'handler' };
    const group = [{ Type: SocketAccessPolicy, Options: [access] }, ...(options.also ?? []).map((Type) => ({ Type, Options: [] }))] as IPolicyGroup;
    SocketPolicyGroup(group)(target, propertyKey, indexOrDescriptor);

    // an inherited rule left in place would be an alternative that widens access, and two deciding rules would race for AuthzDecision
    const descriptor = Reflect.getOwnMetadata(SOCKET_CONTROLLER_DESCRIPTOR, owner) as ISocketControllerDescriptor;
    const groups = propertyKey === undefined ? descriptor.Policies : descriptor.Handlers.get(propertyKey)!.Policies;
    const inherited = groups.findIndex((g) => g !== group && g[0]?.Type === SocketAccessPolicy);
    if (inherited >= 0) {
      groups.splice(inherited, 1);
    }
  };
}

export interface ISocketAccessRule {
  readonly controller: Class<BaseSocketController>;
  /** how boot errors name it: `@SocketAccess on DocsSocket.read` */
  readonly source: string;
  readonly access: ISocketAccess;
}

/** The `@SocketAccess` rules of every registered socket controller. */
export function registeredSocketAccess(): ISocketAccessRule[] {
  const rules: ISocketAccessRule[] = [];

  for (const type of new Set(DI.getRegisteredTypes(BaseSocketController) ?? [])) {
    const controller = type as Class<BaseSocketController>;
    const descriptor = Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, controller.prototype) as ISocketControllerDescriptor | undefined;
    if (!descriptor) {
      continue;
    }

    const scopes: Array<[string, readonly IPolicyGroup[]]> = [[`@SocketAccess on ${controller.name}`, descriptor.Policies], ...[...descriptor.Handlers.values()].map((h): [string, readonly IPolicyGroup[]] => [`@SocketAccess on ${controller.name}.${String(h.Method)}`, h.Policies])];
    for (const [source, groups] of scopes) {
      for (const member of groups.flat()) {
        if (member.Type === SocketAccessPolicy) {
          rules.push({ controller, source, access: member.Options[0] as ISocketAccess });
        }
      }
    }
  }

  return rules;
}

// The controllers whose rules each domain's latest boot read: one registered later is checked by that domain's next boot only.
const bootedWith = new Map<string, ReadonlySet<unknown>>();

/** The rules `domain` checks at its boot ( B02 ); remembers which controllers that boot saw. */
export function bootSocketAccess(domain: string): ISocketAccessRule[] {
  const rules = registeredSocketAccess();
  bootedWith.set(domain, new Set(rules.map((r) => r.controller)));
  return rules.filter((r) => (r.access.domain ?? 'root') === domain);
}

/** The rules of controllers registered after the domain they check in booted: its boot checks skipped them. */
export function missedByBoot(): ISocketAccessRule[] {
  return registeredSocketAccess().filter((r) => bootedWith.get(r.access.domain ?? 'root')?.has(r.controller) === false);
}
