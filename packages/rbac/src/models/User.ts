import { DateTime } from 'luxon';
import { _update, ModelBase, Primary, Connection, Model, Set, CreatedAt, SoftDelete, HasMany, DateTime as DT, QueryScope, ISelectQueryBuilder, MetadataRelation, RawQuery } from '@spinajs/orm';
import { AccessControl, Permission } from 'accesscontrol';
import { DI } from '@spinajs/di';
import { UserMetadata, UserMetadataBase } from './UserMetadata.js';
import { v4 as uuidv4 } from 'uuid';
import { _chain, _catch, _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _or, _is_string, _to_int, _default, _is_uuid, _max_length, _min_length, _is_object } from '@spinajs/util';
import _ from 'lodash';
import { _cfg } from '@spinajs/configuration';

export class UserQueryScopes implements QueryScope {

  public whereMetadata(this: ISelectQueryBuilder<User[]> & UserQueryScopes, key: string, value: any) {
    const k = _check_arg(_or(_is_object(_non_nil()), _is_string(_trim(), _non_empty())))(key, 'key');
    const v = _check_arg(_non_nil())(value, 'value');

    return this.whereExist("Metadata", function () {
      this.where("Key", k);
      this.where("Value", v);
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
          this.where(new RawQuery('user_id = banned_count.Id'));
        }),
      )
      .count()


    return banned > 0;
  }

  public async checkIsActive(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    const active = await this.clearColumns().where('IsActive', true).count();
    return active > 0;
  }

  public notDeleted(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    return this.where({
      DeletedAt: null,
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
      DeletedAt: null,
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
    identifier = _check_arg(_or(_is_number(_gt(0)), _to_int(), _is_string(_trim(), _non_empty())))(identifier, 'identifier');

    return this.when(
      typeof identifier === 'number',
      function () {
        this.where('Id', identifier);
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
}

/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('users')
export class UserBase extends ModelBase {
  /**
   * By default should not return password & id
   * Id - to not expose internal id and predict users id / count
   * Instead id should be replaced with uuid when exposing to end user / app
   */
  protected _hidden: string[] = ['Password', 'Id'];

  protected _ac: AccessControl;

  public static readonly _queryScopes: UserQueryScopes = new UserQueryScopes();

  public constructor(data?: Partial<User>) {
    super(data);

    this.Uuid = _check_arg(_default(uuidv4()))(this.Uuid, 'uuid');
    this.Role = _check_arg(_default([_cfg('rbac.defaultRole')()]))(this.Role, 'role');

    this._ac = DI.get('AccessControl');
  }

  @Primary()
  public Id: number;

  public Uuid: string;

  public Email: string;

  /**
   * Hashed password for user
   */
  public Password: string;

  /**
   * Displayed name ( for others to see )
   */
  public Login: string;

  /**
   * User role
   */
  @Set()
  public Role: string[];

  /**
   * User creation date
   */
  @CreatedAt()
  public CreatedAt: DateTime;

  /**
   * Registration date. User is registered when clicked confirmation link sended to provided email.
   */
  @DT()
  public RegisteredAt: DateTime;

  /**
   * User deletion date
   */
  @SoftDelete()
  public DeletedAt: DateTime;

  @DT()
  public LastLoginAt: DateTime;

  /**
   * Account is fully active (eg. passed registration)
   * Do not use it to ban users, active user still can have banned status
   */
  public IsActive: boolean;

  /**
   * User additional information. Can be anything
   * 
   * We use unsafe model couse its relation. It will only load meta related
   * to owner user anyway
   */
  @HasMany(UserMetadataBase, {
    foreignKey: "user_id"
  })
  public Metadata: MetadataRelation<UserMetadataBase, User>;

  public get IsGuest(): boolean {
    return this.Role.indexOf('guest') !== -1 || this.Role.length === 0;
  }

  public get IsBanned(): boolean {
    return this.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED] === true;
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

  public static getByLogin(login: string) {
    login = _check_arg(_trim(), _non_empty())(login, 'login');

    return UserBase.query().whereLogin(login).first();
  }

  public static getByEmail(email: string) {
    email = _check_arg(_trim(), _non_empty(), _is_email())(email, 'email');

    return UserBase.query().whereEmail(email).first();
  }

  public static getByUuid(uuid: string) {
    uuid = _check_arg(_trim(), _is_uuid())(uuid, 'uuid');

    return UserBase.query().whereUuid(uuid).first();
  }

  /**
   * Tries to get user by any identifier
   *
   * @param identifier login, email, id or uuid
   * @returns
   */
  public static getByAnything(identifier: string | number) {
    return UserBase.query().whereAnything(identifier).first();
  }
}

/**
 * Class defined for ORM resource support
 */
@Connection('default')
@Model('users')
export class User extends UserBase {

}


