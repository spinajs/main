import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { QueueMessageHook, jobOptions } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';
import type { Initiator } from '../api.js';
import { authzFor } from './service.js';
import { InitiatorPrincipalFactory, reviveCeiling } from './initiator.js';

const isPlain = (v: unknown): boolean => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Stamps who emitted a message and decides whose authority its handler has (design §14.2, B30).
 * A handler runs unattended unless its `@Job` says `runAs: 'initiator'` or `'system'`.
 */
@Injectable(QueueMessageHook)
export class AuthzQueueHook extends QueueMessageHook {
  /** The authz domain whose principal is stamped and whose `runAs` the handler uses. */
  @Config('authz.queue.domain', { defaultValue: 'root' })
  protected Domain: string;

  async beforeEmit(message: IQueueMessage): Promise<void> {
    // Whatever the caller put there is dropped: only the ambient principal may be named.
    delete message.Initiator;

    const principal = (await this.service()).current();
    if (principal === UNATTENDED || principal.type === 'unattended') return;
    // A system-typed principal that is not the singleton is forged; stamping it would later become SYSTEM.
    if (principal.type === 'system' && principal !== SYSTEM) return;

    // The stamp cannot carry these; rebuilding without them would widen the job's authority.
    if (principal.onBehalfOf !== undefined || principal.delegation !== undefined || principal.authn?.impersonator !== undefined) return;

    const stamp: Initiator = { type: principal.type, id: principal.id };
    if (principal.ceiling === undefined) {
      message.Initiator = stamp;
      return;
    }
    // A ceiling that is not a plain, well-formed one is stamped as deny-all, never as no restriction.
    const ceiling = isPlain(principal.ceiling) ? reviveCeiling(principal.ceiling) : undefined;
    message.Initiator = { ...stamp, ceiling: ceiling ?? { permissions: [] } };
  }

  async aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    const service = await this.service();
    const { runAs } = jobOptions(message);

    let principal: Principal = UNATTENDED;
    if (runAs === 'system') principal = SYSTEM;
    else if (runAs === 'initiator' && message.Initiator) principal = await this.initiator(message.Initiator as Initiator);

    // Also for unattended: a consumer running inside the emitter's async context must not inherit its principal.
    return service.runAs(principal, `job:${message.Name}`, next);
  }

  protected async initiator(initiator: Initiator): Promise<Principal> {
    const factory = await DI.resolve(InitiatorPrincipalFactory);
    return factory.principalOf(initiator);
  }

  protected async service(): Promise<AuthzService> {
    return authzFor(this.Domain);
  }
}
