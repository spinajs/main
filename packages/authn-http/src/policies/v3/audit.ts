import type { IContainer } from '@spinajs/di';
import { AuthnAudit } from '@spinajs/authn';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import type { AuthnClientContext } from '../../v3/client.js';

/**
 * Publishes an event that no N1 service publishes for this layer through the core AuthnAudit, with the request's time,
 * ip and user agent. Never a raw session id or a credential (A21).
 */
export async function publishAuthnEvent(container: IContainer, client: AuthnClientContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
  const { ip, userAgent } = client;
  await (await container.resolve(AuthnAudit)).publish({ ...e, at: new Date(), ...(typeof ip === 'string' && ip !== '' ? { ip } : {}), ...(typeof userAgent === 'string' && userAgent !== '' ? { userAgent } : {}) });
}
