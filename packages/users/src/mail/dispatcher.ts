import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { PasswordService } from '@spinajs/authn/contracts';
import { InlineAuthnMailDispatcher, authnMailDeliveryOf } from '@spinajs/authn-local';
import type { AuthnMailDispatcher } from '@spinajs/authn-local';
import { QueueAuthnMailDispatcher } from '@spinajs/authn-local/queue';

import { checkAuthnMailRouting } from './check.js';

/**
 * The `AuthnMailDispatcher` for `authn.local.mail.delivery`. A factory because bootstrappers run before the configuration
 * loads: it runs when a PasswordService is built, which then fails on a queue route that loses mails (D12).
 */
export function authnMailDispatcher(container: IContainer): AuthnMailDispatcher {
  const config = container.get(Configuration);
  if (!config) {
    throw new InvalidOperation('The authn mail dispatcher reads authn.local.mail.delivery, and no Configuration is resolved');
  }
  if (config.get<string>('authn.local.mail.delivery') === 'inline') {
    // Resolved only for a failure, so a container without a logger configuration still builds the dispatcher.
    const log = { warn: (...args: unknown[]) => (DI.resolve(Log, ['authn-local']) as Log).warn(...(args as Parameters<Log['warn']>)) };
    return new InlineAuthnMailDispatcher(async (request) => authnMailDeliveryOf(await container.resolve(PasswordService))(request), log);
  }
  checkAuthnMailRouting(config);
  return new QueueAuthnMailDispatcher();
}
