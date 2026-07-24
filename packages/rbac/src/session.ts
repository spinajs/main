import { DateTime } from 'luxon';
import { SessionProvider, ISession } from './interfaces.js';
import { Injectable, NewInstance } from '@spinajs/di';
import { v4 as uuidv4 } from 'uuid';

/**
 * Session base class
 */
@NewInstance()
export class UserSession implements ISession {
  public SessionId: string = uuidv4();

  /**
   * User id that owns this session. Single source of truth for ownership.
   */
  public UserId: number;

  public Creation: DateTime = DateTime.now();

  /**
   * Expiration time for session, if undefined it does not expire.
   * Set by the SessionProvider through the configured expiration strategy.
   */
  public Expiration: DateTime | undefined = undefined;

  public Data: Map<string, unknown> = new Map();

  constructor(session?: Partial<ISession>) {
    if (session) {
      Object.assign(this, session);
    }
  }
}

/**
 * Simple session storage in memory, for testing or rapid prototyping.
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

    // an expired row is treated as absent (and evicted)
    if (this.isExpired(session)) {
      this.Sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
    // A brand-new session without a scheduled expiration gets its initial
    // expiration from the strategy. An already-scheduled expiration is
    // persisted verbatim (fixes B3 — never recompute on every save).
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    this.Sessions.set(session.SessionId, session);
  }

  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    const renewed = this.Expiration.renew(session);

    // no change (e.g. AbsoluteExpiration) — skip the write, report false
    if (this.expirationEquals(current, renewed)) {
      return false;
    }

    session.Expiration = renewed;
    this.Sessions.set(session.SessionId, session);
    return true;
  }

  public async delete(sessionId: string): Promise<void> {
    this.Sessions.delete(sessionId);
  }

  public async deleteByUser(userId: number): Promise<void> {
    for (const [key, session] of this.Sessions.entries()) {
      if (session.UserId === userId) {
        this.Sessions.delete(key);
      }
    }
  }

  public async listByUser(userId: number): Promise<ISession[]> {
    const result: ISession[] = [];
    for (const session of this.Sessions.values()) {
      if (session.UserId === userId && !this.isExpired(session)) {
        result.push(session);
      }
    }
    return result;
  }

  public async truncate(): Promise<void> {
    this.Sessions = new Map<string, ISession>();
  }

  private expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }
}
