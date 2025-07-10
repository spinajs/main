import { DateTime } from 'luxon';
import { SessionProvider, ISession } from './interfaces.js';
import { Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { v4 as uuidv4 } from 'uuid';
import _ from 'lodash';
import { User } from './models/User.js';

/**
 * Session base class
 */
@NewInstance()
export class UserSession implements ISession {
  @Config('rbac.session.expiration')
  protected SessionExpirationTime: number;

  public SessionId: string = uuidv4();

  /**
   * Expiration time for session, if null it does not expire
   */
  public Expiration: DateTime = null;

  public Data: Map<string, unknown> = new Map();

  public Creation: DateTime = DateTime.now();

  /**
   * User id that owns this session
   */
  public UserId: number;

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

  public async truncate(): Promise<void> {
    this.Sessions = new Map<string, ISession>();
  }

  public async touch(session: ISession): Promise<void> {
    return this.save(session);
  }

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

  public async save(idOrSession: ISession | string, data?: object): Promise<void> {
    if (_.isString(idOrSession)) {
      const s = this.Sessions.get(idOrSession);

      for (const key in data) {
        s.Data.set(key, (data as any)[key]);
      }
    } else {
      this.Sessions.set(idOrSession.SessionId, idOrSession);
    }
  }

  public logsOut(user: User): Promise<void> {

    const sessionsToDelete: string[] = [];

    for (const [key, session] of this.Sessions.entries()) {
      if (session.UserId === user.Id) {
        sessionsToDelete.push(key);
      }
    }

    for (const sessionId of sessionsToDelete) {
      this.Sessions.delete(sessionId);
    }

    return Promise.resolve();
  }
}
