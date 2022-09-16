import { DateTime } from 'luxon';
import { SessionProvider, ISession } from './interfaces';
import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { v4 as uuidv4 } from 'uuid';

/**
 * Session base class
 */
@NewInstance()
export class Session implements ISession {
  @Config('rbac.session.expiration')
  protected SessionExpirationTime: number;

  public SessionId: string = uuidv4();

  /**
   * Expiration time for session, if null it does not expire
   */
  public Expiration: DateTime = null;

  public Data: Map<string, unknown> = new Map();

  public Creation: DateTime = DateTime.now();

  constructor(session?: Partial<ISession>) {
    if (session) {
      Object.assign(this, session);
    }
  }

  /**
   * Extends lifetime of session
   *
   * @param seconds - hom mutch to extend
   */
  public extend(seconds?: number) {
    this.Expiration = DateTime.now().plus({ seconds: seconds ? seconds : this.SessionExpirationTime });
  }
}

/**
 * Simple session storage in memory, for testing or rapid prototyping
 */
@Injectable(SessionProvider)
export class MemorySessionStore extends SessionProvider<ISession> {

  protected Sessions: Map<string, ISession> = new Map<string, ISession>();

  public async restore(sessionId: string): Promise<ISession | null> {
    if (this.Sessions.has(sessionId)) {
      const session = this.Sessions.get(sessionId);
      if (!session.Expiration || session.Expiration > DateTime.now()) {
        return session;
      }
      return null;
    }

    return null;
  }

  public async delete(sessionId: string): Promise<void> {
    if (this.Sessions.has(sessionId)) {
      this.Sessions.delete(sessionId);
    }
  }

  public async save(session: ISession): Promise<void> {
    this.Sessions.set(session.SessionId, session);
  }
}
