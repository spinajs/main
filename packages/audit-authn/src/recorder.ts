import { Autoinject, Container, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { audit, auditStore, trailConfig } from '@spinajs/audit';
import { AuthnEventListener } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { securityInput } from './security-event.js';

const LOG_STORE = 'LogAuditStore';
const SECURITY_TRAIL = 'security';
// What the authentication log never carried.
const LOG_OMIT: readonly string[] = ['data.userAgent', 'data.detail'];

// As the audit core matches paths: `*` is any one segment, so `data.*` and `data.*.id` reach the identity as well.
const reachesIdentity = (path: string): boolean => {
  const [root, field] = path.split('.');
  return root === 'data' && (field === 'identity' || field === '*');
};

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

  /** An unknown trail, or one whose store is not registered, throws AuditConfigError here, when AuthnAudit resolves: the boot fails, not every login. */
  public async ready(): Promise<void> {
    await auditStore(trailConfig(this.Trail, this.Container), this.Container);
  }

  public async on(e: AuthnEvent): Promise<void> {
    const trail = trailConfig(this.Trail, this.Container);
    const redaction = trail.store === LOG_STORE ? logRedaction(e) : { hash: [], omit: [] };
    // The subject column cannot be masked: a trail that drops or masks any part of the identity gets none.
    const subject = ![...trail.omit, ...trail.mask, ...trail.hash, ...redaction.hash, ...redaction.omit].some(reachesIdentity);
    await audit(this.Container).record(securityInput(e, { subject }), { trail: trail.name, hash: redaction.hash, omit: redaction.omit });
  }

  /** On a `continue` trail `on` only buffers; this writes the buffer out, for AuthnAudit.settled() and a shutdown. */
  public flush(): Promise<void> {
    return audit(this.Container).flush();
  }
}
