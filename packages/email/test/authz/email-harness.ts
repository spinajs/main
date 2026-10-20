import { basename } from 'node:path';

import { authz } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { AuthzQueueHook, StampedInitiatorPrincipalFactory } from '@spinajs/authz-queue';
import type { Initiator } from '@spinajs/authz-queue';
import type { BehaviourHarness, EmailHandle } from '@spinajs/authz-testing';
import type { IQueueMessage } from '@spinajs/queue';

import { fsHarness } from '../../../authz-fs/test/support/fs-harness.js';
import { BlackHoleEmailSender, DefaultEmailService, EmailSend } from '../../src/index.js';
import type { EmailConnectionOptions, IEmail } from '../../src/index.js';

export type Mail = Parameters<EmailHandle['send']>[0];

export interface EmailLaneHandle extends EmailHandle {
  /** sendDeferred in the current ALS; the queue stamps the message as QueueService.emit does, through AuthzQueueHook.beforeEmit. */
  sendDeferred(mail: Mail): Promise<void>;
  /** Sends every queued EmailSend inside AuthzQueueHook.aroundHandle, as the consumer does; rejects with the first send's error. */
  consume(): Promise<void>;
}

const CONNECTION = 'behaviour';

/**
 * AuthzQueueHook on the case's test domain instead of `authz.queue.domain`, with the default initiator factory built
 * here rather than resolved, so no singleton is left in root.
 */
class DomainQueueHook extends AuthzQueueHook {
  private readonly factory = new StampedInitiatorPrincipalFactory();

  constructor(private readonly domain: string) {
    super();
  }

  protected async service(): Promise<AuthzService> {
    return authz(this.domain);
  }

  protected async initiator(initiator: Initiator): Promise<Principal> {
    return this.factory.principalOf(initiator);
  }
}

const toEmail = (mail: Mail): IEmail => ({
  to: [mail.to],
  connection: CONNECTION,
  subject: 'behaviour mail',
  text: 'see attachments',
  attachements: mail.attachments.map((a) => ({ name: basename(a.path), path: a.path, provider: a.fs })),
});

/**
 * A real DefaultEmailService over one BlackHoleEmailSender connection, built without DI so the case leaves nothing in
 * root. Its `@Config` fields (`email.attachments.check`, `fs.defaultProvider`) read the host's TestConfiguration; only
 * `Configuration` is set here, because sendDeferred reads `email.retry` from it.
 */
function emailHandle(domain: string): EmailLaneHandle {
  const hook = new DomainQueueHook(domain);
  const queued: EmailSend[] = [];
  const options: EmailConnectionOptions = { name: CONNECTION, service: 'BlackHoleEmailSender' };
  const service = new DefaultEmailService();

  (service as unknown as { Senders: Map<string, BlackHoleEmailSender> }).Senders = new Map([[CONNECTION, new BlackHoleEmailSender(options)]]);
  (service as unknown as { Queue: unknown }).Queue = {
    async emit(message: IQueueMessage) {
      await hook.beforeEmit(message);
      if (message instanceof EmailSend) queued.push(message);
    },
  };
  Object.defineProperty(service, 'Configuration', { value: { connections: [options], defaultConnection: CONNECTION, retry: { count: 1 } }, configurable: true });

  return {
    send: (mail) => service.send(toEmail(mail)),
    async sendDeferred(mail) {
      await service.sendDeferred(toEmail(mail));
    },
    async consume() {
      for (const job of queued.splice(0)) {
        await hook.aroundHandle(job, () => service.send(job));
      }
    },
  };
}

/** authz-fs's fs harness (local providers) plus the email facet. */
export function emailHarness(): BehaviourHarness {
  const base = fsHarness({ kind: 'local' });
  return {
    ...base,
    facets: [...base.facets, 'email'],
    async setup(world, ctx) {
      const session = await base.setup(world, ctx);
      return { ...session, lane: { ...session.lane, email: emailHandle(session.domain ?? base.domain ?? 'root') } };
    },
  };
}
