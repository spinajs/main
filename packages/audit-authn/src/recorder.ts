import { Autoinject, Container, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { audit, trailConfig } from '@spinajs/audit';
import { AuthnEventListener } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { securityInput } from './security-event.js';

const LOG_STORE = 'LogAuditStore';
const SECURITY_TRAIL = 'security';
// What the authentication log never carried.
const LOG_OMIT: readonly string[] = ['data.userAgent', 'data.detail'];

const holdsEmail = (ref: { readonly id: unknown } | undefined): boolean => ref !== undefined && String(ref.id).includes('@');

/** SR-19: in a log, an id that may be an email is hashed even when the trail's own hash list was emptied. */
export function logRedaction(e: AuthnEvent): { readonly hash: readonly string[]; readonly omit: readonly string[] } {
  return { hash: [...(holdsEmail(e.identity) ? ['data.identity'] : []), ...(holdsEmail(e.actor) ? ['data.actor'] : [])], omit: LOG_OMIT };
}

/**
 * Records every authentication event as a `security` event of the audit trail named by `audit.authn.trail`.
 * One per container, like AuthnAudit, so a child boot records into the trail its own configuration names.
 */
@PerChildInstance()
@Injectable(AuthnEventListener)
export class AuthnAuditRecorder extends AuthnEventListener {
  @Config('audit.authn.trail', { defaultValue: SECURITY_TRAIL })
  protected Trail!: string;

  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Blocking exactly when the trail rejects: AuthnAudit then hands a success event here first, and a write that still
   * fails after the trail's retries stops the operation that raised it. A trail that cannot be read counts as
   * rejecting, so `on` throws its AuditConfigError where AuthnAudit turns it into AuthnListenerFailed.
   */
  public override get blocking(): boolean {
    try {
      return trailConfig(this.Trail, this.Container).onFailure === 'reject';
    } catch {
      return true;
    }
  }

  /** An unknown trail throws AuditConfigError here, when AuthnAudit resolves: the boot fails, not the first login. */
  public ready(): void {
    trailConfig(this.Trail, this.Container);
  }

  public async on(e: AuthnEvent): Promise<void> {
    const trail = trailConfig(this.Trail, this.Container);
    const redaction = trail.store === LOG_STORE ? logRedaction(e) : { hash: [], omit: [] };
    const subject = !trail.hash.includes('data.identity') && !redaction.hash.includes('data.identity');
    await audit(this.Container).record(securityInput(e, { subject }), { trail: trail.name, hash: redaction.hash, omit: redaction.omit });
  }

  /** On a `continue` trail `on` only buffers; this writes the buffer out, for AuthnAudit.settled() and a shutdown. */
  public flush(): Promise<void> {
    return audit(this.Container).flush();
  }
}
