import type { IContainer } from '@spinajs/di';
import type { Request } from '@spinajs/http';
import type { AuthnEvent } from '@spinajs/authn/contracts';

/**
 * Publishes an event that no N1 service publishes for this layer through the core AuthnAudit, with the request's time,
 * ip and user agent. Never a raw session id or a credential (A21).
 */
export async function publishAuthnEvent(container: IContainer, req: Request, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
  // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
  const { AuthnAudit } = await import('@spinajs/authn');
  const ip = req.storage.ClientIp;
  const userAgent = req.headers['user-agent'];
  await (await container.resolve(AuthnAudit)).publish({ ...e, at: new Date(), ...(typeof ip === 'string' && ip !== '' ? { ip } : {}), ...(typeof userAgent === 'string' && userAgent !== '' ? { userAgent } : {}) });
}
