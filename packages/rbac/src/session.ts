import { DateTime } from 'luxon';
import { SessionProvider, UserSession, UserSessionData } from './interfaces';
import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { v4 as uuidv4 } from 'uuid';

/**
 * Session base class
 */
@NewInstance()
export class Session implements UserSession {
  @Config('rbac.session.expiration')
  protected SessionExpirationTime: number;

  public SessionId: string;

  public Expiration: DateTime;

  public Data: any;

  public Creation: DateTime;

  constructor(data?: UserSessionData) {
    if (data) {
      Object.assign(this, data);
    }

    if (!this.SessionId) {
      this.SessionId = uuidv4();
    }

    /**
     * always extend session time
     */
    this.Expiration =  DateTime.now().plus({ minutes: this.SessionExpirationTime });

    if (!this.Creation) {
      this.Creation = DateTime.now();
    }
  }

  /**
   * Extends lifetime of session
   *
   * @param minutes - hom mutch to extend
   */
  public extend(minutes: number) {
    this.Expiration.plus({ minutes });
  }
}

/**
 * Simple session storage in memory
 */
@Injectable(SessionProvider)
export class MemorySessionStore<T = UserSession> extends SessionProvider<T> {
  @Autoinject()
  protected Configuration: Configuration;

  protected Sessions: Map<string, UserSession> = new Map<string, UserSession>();

  public async restoreSession(sessionId: string): Promise<T> {
    if (this.Sessions.has(sessionId)) {
      const session = this.Sessions.get(sessionId);

      if (session.Expiration <= DateTime.now()) {
        this.deleteSession(session.SessionId);
        return null;
      }

      return session as any;
    }

    return null;
  }

  // tslint:disable-next-line: no-empty
  public async resolveAsync() {}

  public async deleteSession(sessionId: string): Promise<void> {
    if (this.Sessions.has(sessionId)) {
      this.Sessions.delete(sessionId);
    }
  }

  public async updateSession(session: UserSession): Promise<void> {
    this.Sessions.set(session.SessionId, session);
  }

  public async refreshSession(sessionId: string): Promise<void> {
    if (this.Sessions.has(sessionId)) {
      const session = this.Sessions.get(sessionId);

      session.extend(this.Configuration.get<number>('acl.session.expiration', 10));
    }
  }
}
