import { User } from './models/User';
import { AsyncModule } from '@spinajs/di';
import { DateTime } from 'luxon';

export interface UserSessionData {
  /**
   * Session identifier
   */
  SessionId: string;

  /**
   * Expiration date. After that date session is invalid
   */
  Expiration: DateTime;

  /**
   * Session creation date. After that date session is invalid
   */
  Creation: DateTime;

  /**
   * Data holds by session
   */
  Data: any;
}

export interface UserSession extends UserSessionData {
  /**
   *
   * Extends session lifetime
   *
   * @param minutes  - how mutch to extend
   */
  extend(minutes: number): void;
}

/**
 * Service used for generating random password & for hash raw string
 */
export abstract class PasswordProvider {
  /**
   *
   * Checks if hash is valid for given password
   *
   * @param hash - hasth to validate
   * @param password - password to validate
   */
  public abstract verify(hash: string, password: string): Promise<boolean>;

  /**
   *
   * Generate hashed string from user password
   *
   * @param input - string to hash
   */
  public abstract hash(input: string): Promise<string>;

  /**
   * Generates random user password
   */
  public abstract generate(): string;
}

export abstract class AuthProvider<U = User> {
  public abstract exists(user: U): Promise<boolean>;

  public abstract authenticate(email: string, password: string): Promise<U>;
}

export abstract class SessionProvider<T = UserSession> extends AsyncModule {
  /**
   *
   * Load session from store. If not exists or expired returns null
   *
   * @param sessionId - session identifier
   */
  public abstract restoreSession(sessionId: string): Promise<T>;

  /**
   *
   * Deletes session from store
   *
   * @param sessionId - session to delete
   */
  public abstract deleteSession(sessionId: string): Promise<void>;

  /**
   *
   * Adds or updates session in store
   *
   * @param session - session to update / insert
   */
  public abstract updateSession(session: UserSession): Promise<void>;

  /**
   *
   * Extends session expiration time. Extension is set in acl.session.expiration (in seconds)
   *
   * @param sessionId - session to refres
   */
  public abstract refreshSession(sessionId: string | UserSession): Promise<void>;
}
