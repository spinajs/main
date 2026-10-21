import type { AuthnConfigSource } from '@spinajs/authn/env';

/**
 * D12: outside development and test, queued authn mails need a connection that delivers. A missing connection or a
 * `BlackHoleQueueClient` (what authn-local ships as `authn-mail`) would lose every reset and invite mail.
 */
export function checkAuthnMailRouting(_config: AuthnConfigSource): void {
  throw new Error('not implemented: checkAuthnMailRouting');
}
