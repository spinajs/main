import { _insert, _update } from '@spinajs/orm';
import { _use, _zip, _tap, _chain, _catch, _check_arg, _gt, _non_nil, _either, _is_email, _non_empty, _trim, _is_number, _or, _is_string, _to_int, _default, _is_uuid, _max_length, _min_length, _non_null, _to_array } from '@spinajs/util';
import _ from 'lodash';
import { _email_deferred } from '@spinajs/email';
import { _ev } from '@spinajs/queue';
import { USER_COMMON_METADATA, User, UserBase } from './models/User.js';
import { _cfg, _service } from '@spinajs/configuration';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserLogged, UserPasswordChangeRequest, UserPasswordChanged, UserRoleGranted, UserRoleRevoked, UserUnbanned } from './events/index.js';
import { Constructor } from '@spinajs/di';
import { UserEvent } from './events/UserEvent.js';
import { AuthProvider, PasswordProvider, PasswordValidationProvider } from './interfaces.js';
import { DateTime } from 'luxon';
import { ErrorCode } from '@spinajs/exceptions';
import { v4 as uuidv4 } from 'uuid';
import { UserLoginFailed } from './events/UserLoginFailed.js';
import { UserMetadataChange } from './events/UserMetadataChange.js';
import { UserPasswordExpired } from './events/UserPasswordExpired.js';

export enum E_CODES {
  E_TOKEN_EXPIRED,

  E_TOKEN_INVALID,

  E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS,

  E_USER_NOT_FOUND,

  E_USER_ALREADY_EXISTS,

  E_USER_NOT_ACTIVE,

  E_USER_BANNED,

  E_METADATA_NOT_FOUND,

  E_METADATA_NOT_POPULATED,

  E_EMAIL_NOT_CONFIGURED,

  E_NO_EMAIL_TEMPLATE,

  E_NOT_LOGGED,
}

/**
 * ===============================================
 *  HELPER FUNCTIONS
 * ===============================================
 */

export function _set_user_meta(meta: string | { key: string; value: any }[], value: any = null) {
  return async (u: User) => {
    const mArgs = _check_arg(_non_nil(new ErrorCode(E_CODES.E_METADATA_NOT_POPULATED, 'User metadata not loaded', { user: u })), _to_array())(meta, 'Metadata');

    mArgs.forEach((m: string | { key: string; value: any }) => {
      _.isString(m) ? (u.Metadata[m] = value) : (u.Metadata[m.key] = m.value);
    });

    await _chain(
      u,
      _tap(() => u.Metadata.update()),
      _user_ev(UserMetadataChange, () => {
        return mArgs.map((m: string | { key: string; value: any }) => {
          return _.isString(m) ? { key: m, value } : m;
        });
      }),
    );

    return u;
  };
}

export function _get_user_meta(key: string) {
  return async (u: User) => {
    _check_arg(_non_nil(new ErrorCode(E_CODES.E_METADATA_NOT_POPULATED, 'User metadata not loaded', { user: u, key })))(u.Metadata, 'Metadata');
    _check_arg(_non_nil(new ErrorCode(E_CODES.E_METADATA_NOT_FOUND, 'Metadata not found in user data', { user: u, key })))(u.Metadata[key], `Metadata.${key}`);

    return u.Metadata[key];
  };
}

/**
 * Helper function for sending user notification emails
 * Templates are defined in rbac configuration
 *
 * @param cfgTemplate
 * @returns
 */
export function _user_email(cfgTemplate: 'changePassword' | 'created' | 'confirm' | 'deactivated' | 'activated' | 'deleted' | 'unbanned' | 'banned' | 'passwordWillExpire' | 'passwordExpired') {
  interface _tCfg {
    enabled: boolean;
    template: string;
    subject: string;
  }

  return async (u: User) => {
    return _chain<void>(_use(_cfg('rbac.email.connection', 'default'), 'connection'), _use(_cfg(`rbac.email.${cfgTemplate}`), 'template'), ({ connection, template }: { connection: string; template: _tCfg }) => {
      _check_arg(_non_nil(new ErrorCode(E_CODES.E_NO_EMAIL_TEMPLATE, `Email template ${cfgTemplate} not configured. Check rbac.email in config`)))(template, 'template');
      _check_arg(_is_string(_non_empty(), _max_length(128)))(template.template, 'email.template');
      _check_arg(_is_string(_non_empty(), _max_length(128)))(template.subject, 'email.subject');

      return (
        template.enabled &&
        _email_deferred({
          to: [u.Email],
          connection,
          model: u.toJSON(),
          tag: `rbac-user-${cfgTemplate}`,
          template: template.template,
          subject: template.subject,
        })
      );
    });
  };
}

export function _user_ev(event: Constructor<UserEvent>, ...args: any[]) {
  return async (u: User) => {
    await _ev(new event(u, ...args))();
    return u;
  };
}

export function _user_update(data?: Partial<User>) {
  return async (u: User) => {
    await _chain(u, _update<User>(data), _user_ev(UserChanged));
    return u;
  };
}

export function _user(identifier: number | string | User): () => Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof User) {
    return () => Promise.resolve(id);
  }

  return () => User.query().whereAnything(id).populate('Metadata').firstOrFail();
}

/**
 * Unsafe user retrieval. It does not chack for rbac permission, to this
 * function can read ANY user in system. USE IT CAREFULLY
 * 
 * @param identifier 
 * @returns 
 */
export function _user_unsafe(identifier: number | string | User): () => Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof UserBase) {
    return () => Promise.resolve(id);
  }

  return () => UserBase.query().whereAnything(id).populate("Metadata").firstOrFail();
}

/**
 * ===============================================
 * USER ACTIONS
 * ===============================================
 */

export async function activate(identifier: number | string | User) {
  return _chain(_user(identifier), _user_update({ IsActive: true }), _user_ev(UserActivated));
}

export async function deactivate(identifier: number | string | User): Promise<void> {
  return _chain(_user(identifier), _user_update({ IsActive: false }), _user_ev(UserDeactivated));
}

/**
 * 
 * @param email 
 * @param login 
 * @param password 
 * @param roles 
 * @param id optional user id ( if we migrate from other system  we want to keep user id )
 * @returns 
 */
export async function create(email: string, login: string, password: string, roles: string[], id? : number): Promise<{ User: User; Password: string }> {
  const sPassword = await _service('rbac.password', PasswordProvider)();

  email = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(email, 'email');
  login = _check_arg(_trim(), _non_empty(), _max_length(32))(login, 'login');
  password = _check_arg(
    _trim(),
    _default(() => sPassword.generate()),
  )(password, 'password');

  const hPassword = await sPassword.hash(password);

  return _chain(
    // create user
    () =>
      Promise.resolve(
        new User({
          Id: id,
          Email: email,
          Login: login,
          Password: hPassword,
          Role: roles,
          RegisteredAt: DateTime.now(),
          CreatedAt: DateTime.now(),
          IsActive: false,
          Uuid: uuidv4(),
        }),
      ),

    // insert to db
    _insert(),

    // send event
    _user_ev(UserCreated, (u: User) => u.toJSON()),

    // return user & password - if generated we want to know not hashed password
    (u: User) => {
      return { User: u, Password: password };
    },
  );
}

export async function deleteUser(identifier: number | string | User): Promise<void> {
  return _chain(
    _user(identifier),
    _tap((u: User) => u.destroy()),
    _user_ev(UserDeleted),
  );
}

export async function grant(identifier: number | string, role: string): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _user(identifier),
    _tap(async (u: User) => (u.Role = _.uniq([...u.Role, role]))),
    _user_update(),
    _user_ev(UserRoleGranted, role),
  );
}

export async function revoke(identifier: number | string | User, role: string): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _user(identifier),
    _tap(async (u: User) => (u.Role = u.Role.filter((r) => r !== role))),
    _user_update(),
    _user_ev(UserRoleRevoked, role),
  );
}

/**
 *
 * Bans user for specified time. If duration is 0 user is banned for 24h
 *
 * @param identifier user identifier one of : id, uuid, email, login
 * @param reason reson for ban
 * @param duration duration in seconds
 * @returns
 */
export async function ban(identifier: number | string | User, reason?: string, duration?: number): Promise<User> {
  duration = _check_arg(_default(24 * 60 * 60), _is_number(_gt(0)))(duration, 'duration');
  reason = _check_arg(_default('NO_REASON'), _max_length(255))(reason, 'reason');

  return _chain(
    _user(identifier),
    (u: User) => {
      if (u.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]) {
        throw new ErrorCode(E_CODES.E_USER_BANNED, `User is already banned`, { user: u });
      }

      return u;
    },
    _set_user_meta([
      { key: USER_COMMON_METADATA.USER_BAN_DURATION, value: duration },
      { key: USER_COMMON_METADATA.USER_BAN_REASON, value: reason },
      { key: USER_COMMON_METADATA.USER_BAN_IS_BANNED, value: true },
      { key: USER_COMMON_METADATA.USER_BAN_START_DATE, value: DateTime.now() },
    ]),
    _user_ev(UserBanned),
  );
}

/**
 *
 * Unban user
 *
 * @param identifier
 * @returns
 */
export async function unban(identifier: number | string | User): Promise<User> {
  return _chain(
    _user(identifier),
    (u: User) => {
      if (!u.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]) {
        throw new ErrorCode(E_CODES.E_USER_BANNED, `User is already unbanned`, { user: u });
      }
    },
    _set_user_meta('/^user:ban/', null),
    _user_ev(UserUnbanned),
  );
}

export async function passwordChangeRequest(identifier: number | string | User) {
  const pwdWaitTime = await _cfg<number>('rbac.password.reset_wait_time')();

  return _chain(
    _user(identifier),
    _set_user_meta([
      { key: USER_COMMON_METADATA.USER_PWD_RESET_START_DATE, value: DateTime.now() },
      { key: USER_COMMON_METADATA.USER_PWD_RESET_TOKEN, value: uuidv4() },
      { key: USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME, value: pwdWaitTime },
    ]),
    _user_ev(UserPasswordChangeRequest),
  );
}

export async function confirmPasswordReset(identifier: number | string | User, newPassword: string, token: string) {
  return _chain(
    _user(identifier),
    _tap((u: User) =>
      _chain(u, _zip(_get_user_meta(USER_COMMON_METADATA.USER_PWD_RESET_START_DATE), _get_user_meta(USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME)), ([dueDate, waitTime]: [DateTime, number]) => {
        if (dueDate.plus(waitTime) < DateTime.now()) {
          throw new ErrorCode(E_CODES.E_TOKEN_EXPIRED, `Password change token expired, token expiration date is: ${dueDate.toISO()}`, {
            dueDate,
            waitTime,
            time: DateTime.now(),
            user: u,
          });
        }
      }),
    ),
    _tap((u: User) =>
      _chain(u, _get_user_meta(USER_COMMON_METADATA.USER_PWD_RESET_TOKEN), async (resetToken: string) => {
        if (resetToken !== token) {
          throw new ErrorCode(E_CODES.E_TOKEN_INVALID, `Password change token invalid, operation not permitted`, {
            token,
            resetToken,
            user: u,
          });
        }
      }),
    ),
    changePassword(newPassword),
  );
}

export function changePassword(password: string): (u: User) => Promise<User> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  return async (u: User) => {
    return _chain(
      _use(_service('rbac.password', PasswordProvider), 'pwd'),
      _use(_service('rbac.password.validation', PasswordValidationProvider), 'validator'),

      _tap(async ({ validator }: { validator: PasswordValidationProvider }) => {
        if (!validator.check(password)) {
          throw new Error('Password does not meet requirements');
        }
      }),

      // update password
      ({ pwd }: { pwd: PasswordProvider }) => pwd.hash(password),
      (hPassword: string) => _chain(u, _update<User>({ Password: hPassword }), _set_user_meta(USER_COMMON_METADATA.USER_PWD_RESET_LAST_ATTEMPT, DateTime.now().toISO()), _user_ev(UserPasswordChanged)),
    );
  };
}

/**
 *
 * Expire password for user
 *
 * @param identifier
 */
export async function expirePassword(identifier: number | string | User): Promise<void> {
  return await _chain(_user(identifier), (user: User) => deactivate(user), _user_ev(UserPasswordExpired));
}

/**
 * Check if password match user password stored in db
 *
 * @param identifier
 * @param password
 * @returns
 */
export function passwordMatch(password: string) {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  return async (u: User): Promise<boolean> => {
    return await _chain(u, _service('rbac.password', PasswordProvider), async (sPwd: PasswordProvider, u: User) => sPwd.verify(u.Password, password));
  };
}

export async function login(identifier: number | string | User, password: string): Promise<User> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  return await _chain(
    _user_unsafe(identifier),
    _catch(
      (u: User) => {
        return _chain(_service('rbac.auth', AuthProvider), async (sAuth: AuthProvider) => sAuth.authenticate(u.Email, password), _update<User>({ LastLoginAt: DateTime.now() }), _user_ev(UserLogged));
      },
      (err, u: User) => {
        return _chain(
          () => u,

          // send event of failed login
          _user_ev(UserLoginFailed, err),

          // rethrow error for caller
          () => {
            throw err;
          },
        );
      },
    ),
  );
}
