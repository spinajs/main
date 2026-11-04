import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthzDomains, SYSTEM, UNATTENDED, engineLog, parsePermission, resourceKey } from '@spinajs/authz';
import type { AuthzLog, AuthzService, Decision, Principal } from '@spinajs/authz';
import { PermanentJobFailure, QueueMessageHook, jobOptions, systemTaskOf } from '@spinajs/queue';
import type { IQueueMessage, JobOptions } from '@spinajs/queue';
import type { Initiator } from '../api.js';
import { InitiatorPrincipalFactory, reviveCeiling } from './initiator.js';

// The engine reads a ceiling whose expiresAt is not a Date, or whose reason is empty, as deny-all; revival must not repair it.
const isStrictCeiling = (c: { expiresAt?: unknown; reason?: unknown }): boolean => (c.expiresAt === undefined || c.expiresAt instanceof Date) && (c.reason === undefined || (typeof c.reason === 'string' && c.reason !== ''));

const isPlain = (v: unknown): boolean => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/** A `@Job({ access })` the principal does not hold: dead-lettered with `access_denied`, never retried. */
export class JobAccessDenied extends PermanentJobFailure {
  constructor(
    job: string,
    public readonly decision: Decision | undefined,
  ) {
    super('access_denied', decision ? `job ${job} needs ${decision.permission} on ${resourceKey(decision.resource)}${decision.reason ? ` (${decision.reason.code})` : ''}` : `job ${job} declares no permission it may run with`);
  }
}

// A conditional allow on one row cannot be settled here, as no row is loaded: only a definite one, or a type-level one, passes.
const passes = (d: Decision): boolean => d.allowed && (d.residual.op === 'true' || d.resource.id === undefined);

/**
 * Stamps who emitted a message and decides whose authority its handler has (design §14.2, B30).
 * A handler runs unattended unless its `@Job` says `runAs: 'initiator'` or `'system'`.
 */
@Injectable(QueueMessageHook)
export class AuthzQueueHook extends QueueMessageHook {
  /** The authz domain whose principal is stamped and whose `runAs` the handler uses. */
  @Config('authz.queue.domain')
  protected Domain: string;

  @Autoinject(InitiatorPrincipalFactory)
  protected Initiators: InitiatorPrincipalFactory;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  protected Log: AuthzLog = engineLog('authz-queue');

  private readonly undeclared = new Set<unknown>();

  async beforeEmit(message: IQueueMessage): Promise<void> {
    // Whatever the caller put there is dropped: only the ambient principal may be named.
    delete message.Initiator;

    const principal = (await this.service()).current();
    if (principal === UNATTENDED || principal.type === 'unattended') return;
    // A system-typed principal that is not the singleton is forged; stamping it would later become SYSTEM.
    if (principal.type === 'system' && principal !== SYSTEM) return;

    // The stamp cannot carry these; rebuilding without them would widen the job's authority.
    if (principal.onBehalfOf !== undefined || principal.delegation !== undefined || principal.authn?.impersonator !== undefined) return;

    const stamp: Initiator = { type: principal.type, id: String(principal.id) };
    if (principal.ceiling === undefined) {
      message.Initiator = stamp;
      return;
    }
    // A ceiling that is not a plain, well-formed one is stamped as deny-all, never as no restriction.
    const ceiling = isPlain(principal.ceiling) && isStrictCeiling(principal.ceiling) ? reviveCeiling(principal.ceiling) : undefined;
    message.Initiator = { ...stamp, ceiling: ceiling ?? { permissions: [] } };
  }

  async aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    const service = await this.service();
    const options = jobOptions(message);
    const { runAs, access } = options;

    let principal: Principal = UNATTENDED;
    if (runAs === 'system') principal = SYSTEM;
    else if (runAs === 'initiator' && message.Initiator) principal = await this.initiator(message.Initiator as Initiator);
    if (runAs === 'system' && access === undefined) this.warnUndeclared(message);

    // Also for unattended: a consumer running inside the emitter's async context must not inherit its principal.
    return service.runAs(principal, `job:${message.Name}`, async () => {
      if (access !== undefined) await this.authorize(service, principal, message, options);
      return next();
    });
  }

  /** Any one of the `access` permissions on the job's resource; a denial is final. */
  protected async authorize(service: AuthzService, principal: Principal, message: IQueueMessage, { access = [], resource }: JobOptions): Promise<void> {
    let denied: Decision | undefined;
    for (const permission of typeof access === 'string' ? [access] : access) {
      const decision = await service.check({ principal, permission, resource: resource ? resource(message) : { type: parsePermission(permission).resource } });
      if (passes(decision)) return;
      denied ??= decision;
    }
    throw new JobAccessDenied(message.Name, denied);
  }

  /** `runAs: 'system'` without `access` should say why with `@SystemTask` (doctor AUTHZ004); 4.x only warns, once per job class. */
  protected warnUndeclared(message: IQueueMessage): void {
    const type = message.constructor;
    if (systemTaskOf(type) !== undefined || this.undeclared.has(type)) return;
    this.undeclared.add(type);
    this.Log.warn({ job: message.Name }, "Job ${job} runs as SYSTEM with no access and no @SystemTask(reason)");
  }

  protected async initiator(initiator: Initiator): Promise<Principal> {
    return this.Initiators.principalOf(initiator);
  }

  protected async service(): Promise<AuthzService> {
    return this.Domains.service(this.Domain);
  }
}
