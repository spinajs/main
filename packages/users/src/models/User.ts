import { DateTime } from 'luxon';
import { _update, ModelBase, Primary, Connection, Model, CreatedAt, SoftDelete, HasMany, Hidden, DateTime as DT, QueryScope, ISelectQueryBuilder, MetadataRelation, RawQuery, IDehydrateOptions, ModelDataWithRelationData } from '@spinajs/orm';
import { AccessControl, Permission } from 'accesscontrol';
import { DI } from '@spinajs/di';
import { UserMetadata, UserMetadataBase } from './UserMetadata.js';
import { v4 as uuidv4 } from 'uuid';
import { _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _or, _is_string, _to_int, _default, _is_uuid, _max_length, _min_length, _is_object } from '@spinajs/util';
import _ from 'lodash';
import { GLOBAL } from '@spinajs/authz';
import { AUTHZ_ASSIGNMENT_TABLE } from '@spinajs/authz-rbac';

export class UserQueryScopes implements QueryScope {
  /**
   * Users holding any of `roles` as a live GLOBAL assignment of `user:<Uuid>`.
   *
   * It reads `authz_assignment` on the users' own connection, so it misses assignments that
   * `authz.rbac.connection` keeps elsewhere.
   *
   * @deprecated 3.0: getUsersByRole() or AssignmentStore.holders(role, GLOBAL, at). R1 deletes it.
   */
  public withRole(this: ISelectQueryBuilder<User[]> & UserQueryScopes, roles: string[]) {
    const r = _check_arg(_trim(), _non_empty())(roles, 'roles');
    const holders = this.Driver.select()
      .from(AUTHZ_ASSIGNMENT_TABLE)
      .columns(['subject_id'])
      .where({ subject_type: 'user', subject_role: '', scope_type: GLOBAL.type, scope_id: '' })
      .whereIn('role', r)
      .where(function () {
        this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
      });

    return this.whereIn('Uuid', holders);
  }

  /**
   *
   * Finds users with specified metadata key and value. If user has more metadata and one of them is matching it will be included as well
   *
   * @param key metada key
   * @param value metadata value
   * @returns
   */
  public whereMetadata(this: ISelectQueryBuilder<User[]> & UserQueryScopes, key: string, value: any) {
    const k = _check_arg(_or(_is_object(_non_nil()), _is_string(_trim(), _non_empty())))(key, 'key');
    const v = _check_arg(_non_nil())(value, 'value');

    return this.whereExist('Metadata', function () {
      this.where('Key', k);
      this.where('Value', v);
    });
  }

  public whereUser(this: ISelectQueryBuilder<User[]> & UserQueryScopes, userOrEmail: User | string) {
    const u = _check_arg(_or(_is_object(_non_nil()), _is_string(_trim(), _non_empty())))(userOrEmail, 'userOrEmail');

    return this.where('Email', u instanceof User ? u.Email : userOrEmail);
  }

  public async checkIsBanned(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    const banned = await this.clearColumns()
      .whereExist(
        UserMetadata.query().where(function () {
          this.where('Key', USER_COMMON_METADATA.USER_BAN_IS_BANNED);
          this.where('Value', 'true');
          this.where(new RawQuery('user_id = Id'));
        }),
      )
      .selectCount();

    return banned > 0;
  }

  public async checkIsActive(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    const active = await this.clearColumns().where('IsActive', true).selectCount();
    return active > 0;
  }

  public notDeleted(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    return this.where({
      DeletedAt: null as any,
    });
  }

  /**
   *
   * Fetch users that are not banned, are active & email confirmed, not deleted
   *
   */
  public isActiveUser(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    return this.where({
      IsActive: true,
      DeletedAt: null as any,
    });
  }

  public whereEmail(this: ISelectQueryBuilder<User[]> & UserQueryScopes, email: string) {
    email = _check_arg(_trim(), _non_empty(), _is_email())(email, 'email');

    return this.where({
      Email: email,
    });
  }

  public whereLogin(this: ISelectQueryBuilder<User[]> & UserQueryScopes, login: string) {
    login = _check_arg(_trim(), _non_empty())(login, 'login');

    return this.where({
      Login: login,
    });
  }

  public whereUuid(this: ISelectQueryBuilder<User[]> & UserQueryScopes, uuid: string) {
    uuid = _check_arg(_trim(), _is_uuid())(uuid, 'uuid');

    return this.where({
      Uuid: uuid,
    });
  }

  /**
   * Tries to get user by ONE OF:
   *  - UUID
   *  - EMAIL
   *  - LOGIN
   *  - ID
   *
   * @param identifier - login ,email, uuid or id
   * @returns
   */
  public whereAnything(this: ISelectQueryBuilder<User[] | User> & UserQueryScopes, identifier: string | number) {
    identifier = _check_arg(_or(_is_number(_gt(0)), _is_string(_trim(), _non_empty())))(identifier, 'identifier');

    // NOTE: `_to_int()` used to sit in the check list above, and parseInt()
    // happily turns "9f8e7d6c-…" into 9 — so every uuid ( or login ) starting
    // with a digit was looked up as an Id and simply not found. Only a string
    // that is a number END TO END may be treated as an id.
    const id = typeof identifier === 'number' ? identifier : /^\d+$/.test(identifier) ? Number.parseInt(identifier, 10) : null;

    return this.when(
      id !== null,
      function () {
        this.where('Id', id);
      },
      function () {
        this.where('Uuid', identifier).orWhere('Email', identifier).orWhere('Login', identifier);
      },
    );
  }
}

/**
 * Common user metadata keys
 */
export enum USER_COMMON_METADATA {
  /** BAN RELATED META KEYS  */
  USER_BAN_IS_BANNED = 'user:ban:is_banned',
  USER_BAN_START_DATE = 'user:ban:start_date',
  USER_BAN_DURATION = 'user:ban:duration',
  USER_BAN_REASON = 'user:ban:reason',

  /** USER GENERAL INFO */

  USER_AVATAR = 'user:avatar',
  USER_PHONE = 'user:phone',
  USER_NEWSLETTER_ENABLED = 'user:newsletter:enabled',

  /** 2fa token */

  USER_2FA_TOKEN = 'user:2fa:token',

  /** Reset password */

  // is reset password in progress
  USER_PWD_RESET = 'user:pwd:reset',
  // start date of reset password
  USER_PWD_RESET_START_DATE = 'user:pwd_reset:start_date',
  // wait time for reset password
  USER_PWD_RESET_WAIT_TIME = 'user:pwd_reset:wait_time',
  // reset password token
  USER_PWD_RESET_TOKEN = 'user:pwd_reset:token',
  // reset password last succesyfull  attempt
  USER_PWD_RESET_LAST_ATTEMPT = 'user:pwd_reset:last_attempt',

  /**
   * Set by `create()` on an account whose password it generated, burned by
   * `confirmPasswordReset()`. It marks an account that has never been activated and is
   * waiting for its owner to set the first password — which is the only case where a
   * reset may touch an inactive user.
   */
  USER_INVITE_PENDING = 'user:invite:pending',

  /** Login throttling */

  // consecutive failed login attempts since the last success
  USER_LOGIN_ATTEMPTS = 'user:login:attempts',
  // ISO instant until which authentication is refused for this account
  USER_LOGIN_LOCKED_UNTIL = 'user:login:locked_until',
}

/**
 * Metadata that decides whether somebody gets INTO an account, and therefore must
 * never travel out of one — not to the account owner and not to an administrator
 * reading the record through the API.
 *
 * `user:pwd_reset:token` is the sharp one: it is a bearer credential for
 * `POST /auth/password/reset`, and the reset can be requested for anybody without
 * being logged in at all. Handing it back in a user payload turns "read a user"
 * into "take over that user". Ban and lockout state are here for a smaller reason
 * — they tell an attacker exactly how much of the throttle they have burned.
 *
 * Applied to {@link UserMetadataBase._hiddenKeys} by the rbac bootstrapper, so it
 * covers every `dehydrateWithRelations` in every package. Keys that a client
 * legitimately needs ( avatar, phone, ... ) are deliberately absent.
 */
export const USER_SECURITY_METADATA_KEYS: string[] = [USER_COMMON_METADATA.USER_2FA_TOKEN, USER_COMMON_METADATA.USER_PWD_RESET, USER_COMMON_METADATA.USER_PWD_RESET_TOKEN, USER_COMMON_METADATA.USER_PWD_RESET_START_DATE, USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME, USER_COMMON_METADATA.USER_PWD_RESET_LAST_ATTEMPT, USER_COMMON_METADATA.USER_INVITE_PENDING, USER_COMMON_METADATA.USER_BAN_IS_BANNED, USER_COMMON_METADATA.USER_BAN_START_DATE, USER_COMMON_METADATA.USER_BAN_DURATION, USER_COMMON_METADATA.USER_BAN_REASON, USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS, USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL];

/**
 * Key prefixes of account security state (2FA secrets, reset and invite tokens, throttle and ban
 * state). The generic metadata API neither writes nor shows a key under them (design A12).
 */
export const USER_RESERVED_METADATA_PREFIXES: readonly string[] = Object.freeze(['2fa:', 'user:2fa:', 'user:pwd_reset:', 'user:pwd:', 'user:login:', 'user:ban:', 'user:invite:']);

/**
 * Whether a metadata key falls under {@link USER_RESERVED_METADATA_PREFIXES}.
 *
 * The database compares keys by its collation. MySQL's default ones ignore case, width,
 * accents and invisible characters, so `2FA:Token`, `２fa:token` or `2fá:token` address the
 * `2fa:token` row. The key is folded the same way before the prefix check. A collation may
 * fold more than this; callers that address stored rows check the stored key as well.
 */
export function isReservedMetadataKey(key: string): boolean {
  const folded = String(key)
    .normalize('NFKD')
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '')
    .trim()
    .toLowerCase();
  return USER_RESERVED_METADATA_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

/**
 * `users.Password` of an account that has no password yet (an invited one). The column is NOT NULL and the
 * ORM refuses an empty string there; no hash starts with '!', like authn-local's '!expired' marker.
 */
export const NO_PASSWORD = '!none';

/** Login of the system account the deprecated `RbacSystemUserFactory` returns. */
export const SYSTEM_LOGIN = '__system__';

/**
 * Logins of the form `__name__` belong to accounts the framework seeds, so `create()` refuses them: a user who
 * registered `__system__` would otherwise be the system account. NFKC folds the full-width underscore a database
 * collation may treat as `_`.
 */
export function isReservedLogin(login: string): boolean {
  return /^__.*__$/s.test(String(login).normalize('NFKC'));
}

/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('users')
export class UserBase extends ModelBase<UserBase> {
  protected _ac: AccessControl;

  public static readonly _queryScopes: UserQueryScopes = new UserQueryScopes();

  public constructor(data?: Partial<User>) {
    super(data);

    this.Uuid = _check_arg(_default(uuidv4()))(this.Uuid, 'uuid');

    this._ac = DI.get('AccessControl')!;
  }

  /**
   * Hidden so the internal row id never leaves the process: it would let a client predict user
   * ids and count the users. `Uuid` is what identifies a user to the outside world.
   */
  @Primary()
  @Hidden()
  public Id!: number;

  public Uuid!: string;

  public Email!: string;

  /**
   * Hashed password for user. Never dehydrated, and never advertised on a response schema.
   */
  @Hidden()
  public Password!: string;

  /**
   * Displayed name ( for others to see )
   */
  public Login!: string;

  /**
   * Type only: authz-rbac's migrations copy the `users.Role` column into `authz_assignment` and
   * drop it. Nothing in users sets it; only the deprecated 2.x checks (`can*`, `effectiveRoles`)
   * still read a value a 2.x caller put on an instance in memory.
   *
   * @deprecated 3.0: RbacService.rolesOf(principal) or AssignmentStore.forSubjects([user:<Uuid>]). R1 deletes it.
   */
  public declare Role: string[];

  /**
   * User creation date
   */
  @CreatedAt()
  public CreatedAt!: DateTime<true>;

  /**
   * Registration date. User is registered when clicked confirmation link sended to provided email.
   */
  @DT()
  public RegisteredAt!: DateTime<true>;

  /**
   * When the current password was set, from authn's events (`UserAccountSink`); null: none recorded. Hidden like
   * `Password`: credential state, not profile data.
   */
  @DT()
  @Hidden()
  public PasswordSetAt!: DateTime;

  /**
   * User deletion date
   */
  @SoftDelete()
  public DeletedAt!: DateTime;

  @DT()
  public LastLoginAt!: DateTime;

  /**
   * Account is fully active (eg. passed registration)
   * Do not use it to ban users, active user still can have banned status
   */
  public IsActive!: boolean;

  /**
   * User additional information. Can be anything
   *
   * We use unsafe model couse its relation. It will only load meta related
   * to owner user anyway
   */
  @HasMany(UserMetadataBase, {
    foreignKey: 'user_id',
  })
  public Metadata!: MetadataRelation<UserMetadataBase, User>;

  /**
   * Only a user that was never stored, such as the guest factory's, is a guest.
   *
   * @deprecated 3.0: the anonymous principal of `@spinajs/authn`. R1 deletes it.
   */
  public get IsGuest(): boolean {
    return !this.Id;
  }

  public get IsBanned(): boolean {
    if (this.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED] !== true) {
      return false;
    }

    const start = this.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE];
    const duration = this.Metadata[USER_COMMON_METADATA.USER_BAN_DURATION];

    // no start/duration recorded -> treat as a permanent ban
    if (!start || duration === null || duration === undefined) {
      return true;
    }

    const startDt = start instanceof DateTime ? start : DateTime.fromISO(String(start));
    if (!startDt.isValid) {
      return true;
    }

    // ban is still active only until start + duration (seconds) elapses
    return startDt.plus({ seconds: Number(duration) }) > DateTime.now();
  }

  public dehydrateWithRelations(options?: IDehydrateOptions): ModelDataWithRelationData<this> {
    const base = super.dehydrateWithRelations(options) as any as ModelDataWithRelationData<UserBase>;

    /**
     * Hide meta keys we dont want to show publicly
     */
    if (base.Metadata) {
      base.Metadata = base.Metadata.filter((m) => !UserMetadataBase._hiddenKeys.includes(m.Key)) as any;
    }

    return base as any;
  }

  public can(resource: string, permission: string): Permission {
    resource = _check_arg(_trim(), _non_empty())(resource, 'resource');
    permission = _check_arg(_trim(), _non_empty())(permission, 'permission');

    return (this._ac.can(this.Role) as any)[permission](resource);
  }

  /**
   * Shorthand for check if user can read any of specified resource
   * @param resource
   * @returns
   */
  public canReadAny(resource: string) {
    return this.can(resource, 'readAny');
  }

  /**
   * Shortcut for check if user can read own resource
   *
   * @param resource
   * @returns
   */
  public canReadOwn(resource: string) {
    return this.can(resource, 'readOwn');
  }

  /**
   * Shortcut for check if user can update any resource
   *
   * @param resource
   * @returns
   */
  public canUpdateAny(resource: string) {
    return this.can(resource, 'updateAny');
  }

  /**
   * Shortcut for check if user can update own resource
   * @param resource
   * @returns
   */
  public canUpdateOwn(resource: string) {
    return this.can(resource, 'updateOwn');
  }

  /**
   * Shortcut for check if user can delete any resource
   * @param resource
   * @returns
   */
  public canDeleteAny(resource: string) {
    return this.can(resource, 'deleteAny');
  }

  /**
   * Shourtcut for check if user can delete own resource
   * @param resource
   * @returns
   */
  public canDeleteOwn(resource: string) {
    return this.can(resource, 'deleteOwn');
  }

  /**
   * Shortcut for check if user can create any resource
   * @param resource
   * @returns
   */
  public canCreateAny(resource: string) {
    return this.can(resource, 'createAny');
  }

  /**
   * Shourtcut for check if user can create own resource
   * @param resource
   * @returns
   */
  public canCreateOwn(resource: string) {
    return this.can(resource, 'createOwn');
  }

  // this.query(), not UserBase.query(): the receiver class must build the query so subclasses registered as RbacUserModel are honoured
  public static getByLogin(login: string) {
    login = _check_arg(_trim(), _non_empty())(login, 'login');

    return this.query().whereLogin(login).first();
  }

  public static getByEmail(email: string) {
    email = _check_arg(_trim(), _non_empty(), _is_email())(email, 'email');

    return this.query().whereEmail(email).first();
  }

  public static getByUuid(uuid: string) {
    uuid = _check_arg(_trim(), _is_uuid())(uuid, 'uuid');

    return this.query().whereUuid(uuid).first();
  }

  /**
   * Tries to get user by any identifier
   *
   * @param identifier login, email, id or uuid
   * @returns
   */
  public static getByAnything(identifier: string | number) {
    return this.query().whereAnything(identifier).first();
  }
}

/**
 * Class defined for ORM resource support
 */
@Connection('default')
@Model('users')
export class User extends UserBase {}
