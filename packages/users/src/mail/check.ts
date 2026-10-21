import { InvalidOption } from '@spinajs/exceptions';
import { authnAppEnv, isLenientAuthnEnv } from '@spinajs/authn/env';
import type { AuthnConfigSource } from '@spinajs/authn/env';

const ROUTE = 'queue.routing.AuthnMailJob';

type RouteOption = string | { connection?: string };
type QueueConnection = { name?: string; service?: string };

/** The connections `QueueService.emit` sends an AuthnMailJob to, read the way `getConnectionsForMessage` reads them. */
function routedConnections(config: AuthnConfigSource): (string | undefined)[] {
  const fallback = config.get<string | undefined>('queue.default');
  const option = config.get<RouteOption | RouteOption[] | undefined>(ROUTE) ?? fallback;
  const one = (o: RouteOption | undefined): string | undefined => (typeof o === 'object' && o !== null ? (o.connection ?? fallback) : fallback);
  return Array.isArray(option) ? [...new Set(option.map(one))] : [one(option)];
}

/**
 * D12: outside development and test, queued authn mails need a connection that delivers. A missing connection or a
 * `BlackHoleQueueClient` (what authn-local ships as `authn-mail`) would lose every reset and invite mail.
 */
export function checkAuthnMailRouting(config: AuthnConfigSource): void {
  if (isLenientAuthnEnv(authnAppEnv(config))) {
    return;
  }
  const connections = config.get<QueueConnection[] | undefined>('queue.connections') ?? [];
  const remedy = "configure a queue connection that delivers, or set authn.local.mail.delivery to 'inline'";
  for (const name of routedConnections(config)) {
    // QueueService keeps the last connection of a name.
    const connection = [...connections].reverse().find((c) => c?.name === name);
    if (!connection) {
      throw new InvalidOption(`${ROUTE}: AuthnMailJob goes to the queue connection ${JSON.stringify(name ?? null)}, which queue.connections does not define, so no reset or invite mail would be sent; ${remedy}`);
    }
    if (connection.service === 'BlackHoleQueueClient') {
      throw new InvalidOption(`${ROUTE}: AuthnMailJob goes to the queue connection ${JSON.stringify(name)}, a BlackHoleQueueClient that drops every reset and invite mail; ${remedy}`);
    }
  }
}
