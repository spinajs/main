import type { AuthnEvent, AuthnEventSink } from '@spinajs/authn/contracts';
import type { Log } from '@spinajs/log';

export type AuditLog = Pick<Log, 'warn'>;

/**
 * Publishes to every sink in turn (D18). A failing sink is logged by its class and the error name, never the error message
 * (it may echo the event), and never fails the caller.
 */
export async function publishAuthnEvent(sinks: readonly AuthnEventSink[], event: AuthnEvent, log: AuditLog): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink.publish(event);
    } catch (err) {
      log.warn({ sink: sink.constructor.name, eventType: event.type, errorName: (err as Error)?.name ?? typeof err }, '${sink} could not publish ${eventType}: ${errorName}');
    }
  }
}
