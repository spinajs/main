import type { AuthnEvent, AuthnEventSink } from '@spinajs/authn/contracts';

export interface AuditLog {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * Publishes to every sink in turn (D18). A failing sink is logged by its class and the error name, never the error message
 * (it may echo the event), and never fails the caller.
 */
export async function publishAuthnEvent(sinks: readonly AuthnEventSink[], event: AuthnEvent, log: AuditLog): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink.publish(event);
    } catch (err) {
      log.warn(`${sink.constructor.name} could not publish ${event.type}: ${(err as Error)?.name ?? typeof err}`);
    }
  }
}
