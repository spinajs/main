import { User } from './models/User.js';
import { AsyncService } from '@spinajs/di';
import { legacyService } from './legacy-services.js';
import { DateTime } from 'luxon';

/** @deprecated 3.0: ISession of @spinajs/authn-session (Subject, State). R1 deletes it after N8a and C2. */
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
 * `authn.session.expiration.service`, mirroring the `authn.local.hasher` pattern.
 *
 * Units for all shipped strategies are MINUTES.
 *
 * @deprecated 3.0: SessionExpirationProvider of @spinajs/authn-session. R1 deletes it with the 2.x session store.
 */
export abstract class LegacySessionExpirationProvider {
  /**
   * Expiration to set when a session is first created. `undefined` = never expires.
   */
  public abstract initial(session: ISession): DateTime | undefined;

  /**
   * Expiration to set when a session is renewed (touch).
   */
  public abstract renew(session: ISession): DateTime | undefined;
}

/** @deprecated 3.0: LegacySessionExpirationProvider, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export const SessionExpirationProvider = LegacySessionExpirationProvider;
/** @deprecated 3.0: LegacySessionExpirationProvider, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export type SessionExpirationProvider = LegacySessionExpirationProvider;

/**
 * Service used for generating random password & for hash raw string
 *
 * @deprecated 3.0: PasswordHasher of @spinajs/authn-local. R1 deletes it after N8a and C2.
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
   * Generates a random password drawn from `authn.local.generator` and
   * satisfying `authn.local.policy.rule`.
   */
  public abstract generate(): string;
}

/**
 * Provides standard authentication based on login & password
 *
 * Unlike federated auth providers, it check local db for user,
 * or some kind of other source
 *
 * @deprecated 3.0: LocalPasswordStrategy (authn-local) behind AuthnService.authenticate. R1 deletes it after N8a.
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

/** @deprecated 3.0: SessionProvider of @spinajs/authn-session, behind SessionIssuer. R1 deletes it after N8a and C2. */
export abstract class LegacySessionProvider<T extends ISession = ISession> extends AsyncService {
  private _expiration?: LegacySessionExpirationProvider;

  /**
   * Expiration strategy, resolved by config service name at
   * `authn.session.expiration`. Every store shares the same strategy so
   * expiration semantics are uniform across providers. Without the key, the
   * last registered strategy (`SlidingCappedExpiration`, the 2.x default).
   */
  protected get Expiration(): LegacySessionExpirationProvider {
    return (this._expiration ??= legacyService('authn.session.expiration', LegacySessionExpirationProvider) as LegacySessionExpirationProvider);
  }

  protected set Expiration(value: LegacySessionExpirationProvider) {
    this._expiration = value;
  }

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

/** @deprecated 3.0: LegacySessionProvider, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export const SessionProvider = LegacySessionProvider;
/** @deprecated 3.0: LegacySessionProvider, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export type SessionProvider<T extends ISession = ISession> = LegacySessionProvider<T>;

/** @deprecated 3.0: permission names '<resource>:<action>' and relations of @spinajs/authz. R1 deletes it. */
export type PermissionType = 'readAny' | 'readOwn' | 'updateAny' | 'updateOwn' | 'deleteAny' | 'deleteOwn' | 'createAny' | 'createOwn';

/**
 * What a client may tell the user about the password rule BEFORE they submit
 * one - the human-facing counterpart of {@link PasswordValidationProvider.check}.
 *
 * Every constraint is optional: a provider that validates in a way it cannot
 * describe (a breach-list lookup, say) answers with only what it can, and a
 * client renders whatever is present. `pattern` is an ECMAScript regular
 * expression source, the JSON-schema dialect, so a browser can compile it with
 * `new RegExp(pattern)` and refuse a password locally with the same verdict the
 * server will give.
 */
/** @deprecated 3.0: PasswordPolicy of @spinajs/authn/contracts. R1 deletes it after N8a. */
export interface IPasswordPolicy {
  /** Fewest characters accepted. */
  minLength?: number;

  /** Most characters accepted. */
  maxLength?: number;

  /** ECMAScript regular expression source every accepted password matches. */
  pattern?: string;

  /**
   * Human-readable statement of the rule, as configured by the application
   * (`authn.local.policy.description`). Copy, not a constraint: a client
   * shows it next to the password field; it never validates against it.
   */
  description?: string;
}

/**
 * Interface to provide implementation of password rule validation
 *
 * @deprecated 3.0: LocalPasswordPolicy (authn-local), PasswordService.check and .policy. R1 deletes it after N8a.
 */
export abstract class PasswordValidationProvider {
  public abstract check(password: string): boolean;

  /**
   * Describe the rule `check()` enforces, for display before a password is
   * chosen. The default says nothing at all - an implementation that can
   * state its constraints should override this so clients stop hardcoding a
   * mirror of the server rule.
   */
  public describe(): IPasswordPolicy {
    return {};
  }
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
   * Currently selected role from User.Role list. When set, all request-bound
   * permission checks (rbac query middleware, RbacPolicy) use this single role
   * instead of the full role array. The user may switch via /auth/active-role.
   *
   * @deprecated 3.0: principal.ceiling?.roles (role switch, authn). R1 deletes it.
   */
  ActiveRole?: string;

  /**
   * Original user when an impersonation is active. `User` then holds the
   * target user; `Impersonator` holds whoever initiated impersonation.
   * Unset on regular (non-impersonated) requests.
   */
  Impersonator?: U;
}
