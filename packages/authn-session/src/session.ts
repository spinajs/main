import { DateTime } from 'luxon';
import { Injectable, NewInstance } from '@spinajs/di';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { SessionProvider } from './contracts.js';
import type { ISession } from './contracts.js';
import { belongsTo, expirationEquals } from './match.js';
import { adaptLegacySession } from './legacy.js';

/**
 * A stored session row. `SessionId` is the storage key the issuer gives it
 * (sha256 of the raw id); it has no default, so a raw-looking id can never
 * reach a store by accident.
 */
@NewInstance()
export class UserSession implements ISession {
  public SessionId!: string;

  public Subject!: IdentityRef;

  public Impersonator?: IdentityRef;

  public State: SessionHandle['state'] = 'active';

  public Creation: DateTime = DateTime.now();

  /** `undefined` = never expires; set by the store through the configured strategy. */
  public Expiration: DateTime | undefined = undefined;

  public Data: Map<string, unknown> = new Map();

  constructor(session?: Partial<ISession>) {
    if (session) {
      Object.assign(this, session);
    }
  }
}

/**
 * Simple session storage in memory, for testing or a single instance.
 * Keeps live session objects (no serialization).
 */
@Injectable(SessionProvider)
export class MemorySessionStore extends SessionProvider<ISession> {
  protected Sessions: Map<string, ISession> = new Map<string, ISession>();

  public async restore(sessionId: string): Promise<ISession | null> {
    const session = this.Sessions.get(sessionId);
    if (!session) {
      return null;
    }

    if (this.isExpired(session)) {
      this.Sessions.delete(sessionId);
      return null;
    }

    return adaptLegacySession(session);
  }

  public async save(session: ISession): Promise<void> {
    // Only a brand-new session gets its initial expiration; a scheduled one is kept verbatim (B3).
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    this.Sessions.set(session.SessionId, session);
  }

  /** Update-only: writes Expiration and Data of a row that still exists, never re-creates a deleted one. */
  public async touch(session: ISession): Promise<boolean> {
    if (!this.Sessions.has(session.SessionId)) {
      return false;
    }

    const current = session.Expiration;
    this.applyRenewedExpiration(session);
    this.Sessions.set(session.SessionId, session);
    return !expirationEquals(current, session.Expiration);
  }

  public async delete(sessionId: string): Promise<void> {
    this.Sessions.delete(sessionId);
  }

  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    let count = 0;
    for (const [key, row] of [...this.Sessions.entries()]) {
      const session = adaptLegacySession(row);
      if (session && key !== opts?.except && belongsTo(session, subject, opts?.includeImpersonations)) {
        this.Sessions.delete(key);
        if (!this.isExpired(session)) {
          count++;
        }
      }
    }
    return count;
  }

  public async listBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean }): Promise<ISession[]> {
    return [...this.Sessions.values()]
      .map((row) => adaptLegacySession(row))
      .filter((s): s is ISession => !!s && !this.isExpired(s) && belongsTo(s, subject, opts?.includeImpersonations));
  }

  public async truncate(): Promise<void> {
    this.Sessions = new Map<string, ISession>();
  }
}
