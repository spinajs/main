import { User } from './models/User.js';
import { AsyncService } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
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
   * User id that owns this session. Single source of truth for ownership.
   * 0 / -1 = anonymous.
   */
  UserId: number;

  /**
   * Session creation date.
   */
  Creation: DateTime;

  /**
   * Absolute expiration instant. After that date session is invalid.
   * `undefined` = never expires.
   */
  Expiration?: DateTime;

  /**
   * Data holds by session
   */
  Data: Map<string, unknown>;
}

/**
 * Configurable session expiration strategy. Resolved by config service name at
 * `rbac.session.expiration.service`, mirroring the `rbac.password` pattern.
 *
 * Units for all shipped strategies are MINUTES.
 */
export abstract class SessionExpirationProvider {
  /**
   * Expiration to set when a session is first created. `undefined` = never expires.
   */
  public abstract initial(session: ISession): DateTime | undefined;

  /**
   * Expiration to set when a session is renewed (touch).
   */
  public abstract renew(session: ISession): DateTime | undefined;
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
  public abstract authenticate(login: string, password: string): Promise<U>;

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
  public abstract authenticate(credentials: C): Promise<U>;
}

export abstract class SessionProvider<T extends ISession = ISession> extends AsyncService {
  /**
   * Expiration strategy, resolved by config service name at
   * `rbac.session.expiration`. Every store shares the same strategy so
   * expiration semantics are uniform across providers.
   */
  @AutoinjectService('rbac.session.expiration')
  protected Expiration!: SessionExpirationProvider;

  /**
   * Load session from store. Returns `null` when the session is missing OR
   * expired — providers MUST treat an expired row as absent.
   *
   * @param sessionId - session identifier
   */
  public abstract restore(sessionId: string): Promise<T | null>;

  /**
   * Upsert a session. MUST persist `session.Expiration` verbatim (never
   * recompute it for an already-scheduled session). A brand-new session with
   * no expiration set yet is given its initial expiration via the strategy.
   *
   * @param session - session to update / insert
   */
  public abstract save(session: ISession): Promise<void>;

  /**
   * Recompute `Expiration` via the strategy; if it changed, persist and report
   * `true` so the caller refreshes the cookie. If unchanged (e.g. under
   * `AbsoluteExpiration`), skip the write and return `false`.
   *
   * @param session - session to renew
   */
  public abstract touch(session: ISession): Promise<boolean>;

  /**
   * Deletes a single session from store.
   *
   * @param sessionId - session to delete
   */
  public abstract delete(sessionId: string): Promise<void>;

  /**
   * Log a user out of all devices. Keyed on numeric `UserId` in every store.
   *
   * @param userId - numeric owner id
   */
  public abstract deleteByUser(userId: number): Promise<void>;

  /**
   * All live (non-expired) sessions for a user — powers "active devices" and
   * selective revoke.
   *
   * @param userId - numeric owner id
   */
  public abstract listByUser(userId: number): Promise<ISession[]>;

  /**
   * Deletes all session table data.
   */
  public abstract truncate(): Promise<void>;

  /**
   * Sets the initial expiration on a freshly created session.
   */
  protected applyInitialExpiration(s: ISession): void {
    s.Expiration = this.Expiration.initial(s);
  }

  /**
   * Sets the renewed expiration on a session being touched.
   */
  protected applyRenewedExpiration(s: ISession): void {
    s.Expiration = this.Expiration.renew(s);
  }

  /**
   * True when the session carries an expiration in the past.
   */
  protected isExpired(s: ISession): boolean {
    return !!s.Expiration && s.Expiration <= DateTime.now();
  }
}

export enum AthenticationErrorCodes {
  E_USER_BANNED = 1,
  E_USER_NOT_ACTIVE = 2,
  E_INVALID_CREDENTIALS = 3,
  E_LOGIN_ATTEMPTS_EXCEEDED = 4,
}

export type PermissionType = 'readAny' | 'readOwn' | 'updateAny' | 'updateOwn' | 'deleteAny' | 'deleteOwn' | 'createAny' | 'createOwn';

export interface IRbacModelDescriptor extends IModelDescriptor {
  RbacResource: string;

  OwnerField: string;
}

/**
 * Interface to provide implementation of password rule validation
 */
export abstract class PasswordValidationProvider {
  public abstract check(password: string): boolean;
}


export class UserProfile<T> { 
  public User: User;
  public AdditionalData?: T;

  public constructor(user : User, data? :  T){ 
    this.User = user;
    this.AdditionalData = data;
  }
}

/**
 * Base class for user profile retrieval
 * 
 * User can have not only basic information, but some extended one
 * eg. user profile have information about number of posts, sales etc.
 */
export abstract class UserProfileProvider { 
  public abstract retrieve<T>(user : string | number  | User) : Promise<UserProfile<T>>;
}


export interface IRbacAsyncStorage<U = User> {
  User?: U;

  Session?: ISession;

  /**
 * Controller route permission context
 * To check if we run from (read|update|insert|delete)Own or (read|update|insert|delete)Any scope
 *
 * eg. we want to read only current user data but it has admin privlidges too....
 */
  PermissionScope?: PermissionType;

  /**
   * Currently selected role from User.Role list. When set, all request-bound
   * permission checks (rbac query middleware, RbacPolicy) use this single role
   * instead of the full role array. The user may switch via /auth/active-role.
   */
  ActiveRole?: string;

  /**
   * Original user when an impersonation is active. `User` then holds the
   * target user; `Impersonator` holds whoever initiated impersonation.
   * Unset on regular (non-impersonated) requests.
   */
  Impersonator?: U;

  /**
   * When set, RbacModelPermissionMiddleware skips injecting permission
   * constraints into query builders for this execution context.
   * Set via @SkipModelPermission() decorator for controller actions
   * that are assumed safe to execute without rbac query filtering.
   */
  SkipModelPermissionCheck?: boolean;
}
