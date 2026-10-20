import { randomUUID } from 'node:crypto';

import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef, PrincipalRef } from '@spinajs/authn/contracts';
import { Injectable, Singleton } from '@spinajs/di';
import { ormReady } from '@spinajs/orm';

import { identityKey } from '../identity.js';
import { AuthnAudit } from '../models/AuthnAudit.js';
import { checkedMs, cutText, instant } from '../support/sql.js';
import { columnValues } from '../support/values.js';

function keyOrNull(ref: IdentityRef | PrincipalRef | undefined): string | null {
  if (!ref) return null;
  try {
    return identityKey(ref);
  } catch {
    return null;
  }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return JSON.stringify({ unserialisable: true });
  }
}

/**
 * One `authn_audit` row per event (SR-11). Nothing in an event makes the write fail, so a sink never fails a call
 * whose work is already done (D4 over D1): free text longer than its column is cut, and an identity or actor that
 * does not fit its column leaves the column null and goes whole into `data` (`identityRef`, `actorRef`).
 */
@Singleton()
@Injectable(AuthnEventSink)
export class DbAuthnAuditSink extends AuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    const identity = keyOrNull(e.identity);
    const actor = keyOrNull(e.actor);
    const extra = {
      ...(e.identity && identity === null ? { identityRef: { type: e.identity.type, id: e.identity.id } } : {}),
      ...(e.actor && actor === null ? { actorRef: { type: e.actor.type, id: e.actor.id } } : {}),
    };
    const data = e.data === undefined && Object.keys(extra).length === 0 ? undefined : { ...(e.data ?? {}), ...extra };
    const at = instant(checkedMs(e.at, 'DbAuthnAuditSink.publish: e.at'));
    await ormReady();
    await AuthnAudit.insert(
      columnValues<AuthnAudit>({
        id: randomUUID(),
        at,
        type: cutText(e.type, 32),
        outcome: cutText(e.outcome, 8),
        identity,
        actor,
        strategy: cutText(e.strategy, 64),
        reason: cutText(e.reason, 64),
        ip: cutText(e.ip, 64),
        user_agent: cutText(e.userAgent, 255),
        session: cutText(e.session, 64),
        data: data === undefined ? null : json(data),
      }),
    );
  }
}
