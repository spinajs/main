import { User } from './models/User.js';
import { AsyncService } from '@spinajs/di';
import { IDeleteQueryBuilder, IModelDescriptor, IQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder, ModelBase } from '@spinajs/orm';
import { DateTime } from 'luxon';

declare module '@spinajs/orm' {
  export interface IModelStatic {
    /**
     *
     * Alters query to check ownership of queried resource. Ensures that query returns/modify/delete only owned user data
     *
     * @param query query to alter
     * @param user user to check againts ownership
     * @param modelDescriptor resource model descriptor
     */
    ensureOwnership(query: ISelectQueryBuilder<any> | IUpdateQueryBuilder<any> | IDeleteQueryBuilder<any>, user: User): IQueryBuilder;

    /**
     * Checks ownership of retrieved model by user
     * @param model model
     * @param user user to check against ownership
     */
    checkOwnership<M>(model: ModelBase<M>, user: User): Promise<boolean>;

    /**
     * Checks ownership of model by its primary key
     * @param model primary key to check
     * @param user user to check against ownership
     */
    checkOwnership<M>(primaryKey: string | number, user: User): Promise<boolean>;

    /**
     * Checks ownership of retrieved model by user
     * @param model model / primary key to check
     * @param user user to check against ownership
     */
    checkOwnership<M>(modelOrPrimaryKey: ModelBase<M> | string | number, user: User): Promise<boolean>;
  }
}

export interface ISession {
  /**
   * Session identifier
   */
  SessionId: string;

  /**
   * Expiration date. After that date session is invalid
   */
  Expiration?: DateTime;

  /**
   * Session creation date. After that date session is invalid
   */
  Creation: DateTime;

  /**
   * Data holds by session
   */
  Data: Map<string, unknown>;

  /**
   *
   * Extends session lifetime
   *
   * @param seconds  - how mutch to extend, if value not provided, default value from config is used
   */
  extend(seconds?: number): void;
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

/**
 * Provides standard authentication based on login & password
 *
 * Unlike federated auth providers, it check local db for user,
 * or some kind of other source
 */
export abstract class AuthProvider<U = User> {
  /**
   *
   * Checks if user is already exists with given email
   *
   * @param emailOrUser - email or user object
   */
  public abstract exists(emailOrUser: U | string): Promise<boolean>;

  /**
   *
   * Authenticate user with login and pass, if succeded auth result contains user object
   *
   * @param login - user login
   * @param password  - user password
   */
  public abstract authenticate(login: string, password: string): Promise<IAuthenticationResult<U>>;

  /**
   *
   * Checks if user is banned in DB.
   *
   * @param login - user login
   */
  public abstract isBanned(emailOrUser: U | string): Promise<boolean>;

  /**
   * Checks if user is active in DB.
   *
   * @param login - user login
   */
  public abstract isActive(emailOrUser: U | string): Promise<boolean>;

  /**
   *
   * Cheks if user is deleted
   *
   * @param login - user login
   */
  public abstract isDeleted(emailOrUser: U | string): Promise<boolean>;

  /**
   *
   * Gets user from auth store
   *
   * @param login - user login
   */
  public abstract getByLogin(login: string): Promise<U>;

  /**
   *
   * Gets user from auth store
   *
   * @param email - user email
   */
  public abstract getByEmail(email: string): Promise<U>;

  /**
   *
   * Gets user from auth store
   *
   * @param uuid - user uuid
   */
  public abstract getByUUID(uuid: string): Promise<U>;
}

/**
 * Used for implementign authentication with external services
 * eg. slack or facebook that uses openid or similar auth
 *
 * NOTE: it should only authorize user, it should not register new one if
 * not exists in use DB.
 */
export abstract class FederatedAuthProvider<C, U = User> {
  /**
   * Name of strategy
   */
  abstract get Name(): string;

  /**
   *
   * login service provides Host header for check
   * whitch service is trying to authenticate
   *
   * Base on host adress we choose auth provider
   *
   * @param caller - caller url
   */
  public abstract callerCheck(caller: string): boolean;

  /**
   *
   * Authenticates user based on response from external auth service
   *
   * @param credentials - provided credentials eg. data with token
   */
  public abstract authenticate(credentials: C): Promise<IAuthenticationResult<U>>;
}

export abstract class SessionProvider<T = ISession> extends AsyncService {
  /**
   *
   * Load session from store. If not exists or expired returns null
   *
   * @param sessionId - session identifier
   */
  public abstract restore(sessionId: string): Promise<T>;

  /**
   *
   * Deletes session from store
   *
   * @param sessionId - session to delete
   */
  public abstract delete(sessionId: string): Promise<void>;

  /**
   *
   * Adds or updates session in store
   *
   * @param session - session to update / insert
   */
  public abstract save(session: ISession): Promise<void>;

  /**
   *
   * Updates session data for given id
   *
   * @param id - session id
   * @param data  - key - value pair of data
   */
  public abstract save(id: string, data: object): Promise<void>;

  /**
   *
   * Updates only EXPIRATION TIME of session, not changing other data
   *
   * @param session - session to update
   */
  public abstract touch(session: ISession): Promise<void>;

  /**
   *
   * Deletes all session table data
   *
   */
  public abstract truncate(): Promise<void>;
}

export enum AthenticationErrorCodes {
  E_USER_BANNED = 1,
  E_USER_NOT_ACTIVE = 2,
  E_INVALID_CREDENTIALS = 3,
  E_LOGIN_ATTEMPTS_EXCEEDED = 4,
}

export interface IRbacModelDescriptor extends IModelDescriptor {
  RbacResource: string;
}

/**
 * Authentication result
 */
export interface IAuthenticationResult<U = User> {
  /**
   * If auth is succeded, user field is not null
   */
  User?: U;

  /**
   * If result failed, Error field is not null
   */
  Error?: {
    /**
     * Error code eg E_IS_BANNED
     */
    Code: string | AthenticationErrorCodes;

    /**
     * Optional message
     */
    Message?: string;
  };
}

/**
 * Interface to provide implementation of password rule validation
 */
export abstract class PasswordValidationProvider {
  public abstract check(password: string): boolean;
}
