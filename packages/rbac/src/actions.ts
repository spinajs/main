import { _insert, _update } from '@spinajs/orm';
import { _use, _zip, _tap, _chain, _catch, _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _or, _is_string, _to_int, _default, _is_uuid, _max_length, _min_length } from '@spinajs/util';
import _ from 'lodash';
import { _email_deferred } from '@spinajs/email';
import { _ev } from '@spinajs/queue';
import { USER_COMMON_MEDATA, User } from './models/User.js';
import { _cfg, _service } from '@spinajs/configuration';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserLogged, UserPasswordChangeRequest, UserPasswordChanged, UserRoleGranted, UserRoleRevoked, UserUnbanned } from './events/index.js';
import { Constructor } from '@spinajs/di';
import { UserEvent } from './events/UserEvent.js';
import { AuthProvider, PasswordProvider, PasswordValidationProvider } from './interfaces.js';
import { DateTime } from 'luxon';
import { ErrorCode } from '@spinajs/exceptions';
import { v4 as uuidv4 } from 'uuid';

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

function _set_user_meta(meta: string | { key: string; value: any }[], value: any = null) {
  return async (u: User) => {
    _check_arg(_non_nil(new ErrorCode(E_CODES.E_METADATA_NOT_POPULATED, 'User metadata not loaded', { user: u })))(u.Metadata, 'Metadata');

    if (Array.isArray(meta)) {
      for (const m of meta) {
        u.Metadata[m.key] = m.value;
      }
    } else {
      u.Metadata[meta] = value;
    }
    await u.Metadata.sync();

    return u;
  };
}

function _get_user_meta(key: string) {
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
function _user_email(cfgTemplate: 'changePassword' | 'created' | 'confirm' | 'deactivated' | 'deleted' | 'unbanned' | 'banned') {
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

      template.enabled &&
        _email_deferred({
          to: [u.Email],
          connection,
          model: u.toJSON(),
          tag: `rbac-user-${cfgTemplate}`,
          template: template.template,
          subject: template.subject,
        });
    });
  };
}

function _user_ev(event: Constructor<UserEvent>, ...args: any[]) {
  return async (u: User) => {
    return _ev(new event(u, ...args));
  };
}

function _update_user(data?: Partial<User>) {
  return (u: User) => {
    return _chain(Promise.resolve(u), _update(data), _user_ev(UserChanged), true);
  };
}

function _user(identifier: number | string | User): () => Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof User) {
    return () => Promise.resolve(id);
  }

  return () => User.query().whereAnything(id).populate('Metadata').firstOrFail();
}

/**
 * ===============================================
 * USER ACTIONS
 * ===============================================
 */

export async function activate(identifier: number | string | User) {
  return _chain(_user(identifier), _update<User>({ IsActive: true }), _user_ev(UserActivated), _user_email('created'));
}

export async function deactivate(identifier: number | string): Promise<void> {
  return _chain(_user(identifier), _update<User>({ IsActive: true }), _user_ev(UserDeactivated), _user_email('deactivated'));
}

export async function create(email: string, login: string, password: string, roles: string[]): Promise<User> {
  const sPassword = await _service<PasswordProvider>('rbac.password')();

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
          Email: email,
          Login: login,
          Password: hPassword,
          Role: roles,
          RegisteredAt: DateTime.now(),
          IsActive: false,
          Uuid: uuidv4(),
        }),
      ),

    // insert to db
    _insert(),

    // send event
    _user_ev(UserCreated, (u: User) => u.toJSON()),

    // send email if needed
    _user_email('confirm'),

    // return user & password - if generated we want to know not hashed password
    (u: User) => {
      return { User: u, Password: password };
    },
  );
}

export async function deleteUser(identifier: number | string): Promise<User> {
  return _chain(_user(identifier), (u: User) => u.destroy(), _user_ev(UserDeleted), _user_email('deleted'), true);
}

export async function grant(identifier: number | string, role: string): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _user(identifier),
    _tap(async (u: User) => (u.Role = _.uniq([...u.Role, role]))),
    _update_user(),
    _user_ev(UserRoleGranted, role),
  );
}

export async function revoke(identifier: number | string | User, role: string): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _user(identifier),
    _tap(async (u: User) => (u.Role = u.Role.filter((r) => r !== role))),
    _update_user(),
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
      if (u.Metadata[USER_COMMON_MEDATA.USER_BAN_IS_BANNED]) {
        throw new ErrorCode(E_CODES.E_USER_BANNED, `User is already banned`, { user: u });
      }
    },
    _set_user_meta([
      { key: USER_COMMON_MEDATA.USER_BAN_DURATION, value: duration },
      { key: USER_COMMON_MEDATA.USER_BAN_REASON, value: reason },
      { key: USER_COMMON_MEDATA.USER_BAN_IS_BANNED, value: true },
      { key: USER_COMMON_MEDATA.USER_BAN_START_DATE, value: DateTime.now() },
    ]),
    _user_ev(UserBanned),
    _user_email('banned'),
  );
}

/**
 *
 * Unba user
 *
 * @param identifier
 * @returns
 */
export async function unban(identifier: number | string | User): Promise<User> {
  return _chain(
    _user(identifier),
    (u: User) => {
      if (!u.Metadata[USER_COMMON_MEDATA.USER_BAN_IS_BANNED]) {
        throw new ErrorCode(E_CODES.E_USER_BANNED, `User is already unbanned`, { user: u });
      }
    },
    _set_user_meta('/^user:ban/', null),
    _user_ev(UserUnbanned),
    _user_email('unbanned'),
  );
}

export async function passwordChangeRequest(identifier: number | string | User) {
  const pwdWaitTime = await _cfg<number>('rbac.password.reset_wait_time')();

  return _chain(
    _user(identifier),
    _set_user_meta([
      { key: USER_COMMON_MEDATA.USER_PWD_RESET_START_DATE, value: DateTime.now() },
      { key: USER_COMMON_MEDATA.USER_PWD_RESET_TOKEN, value: uuidv4() },
      { key: USER_COMMON_MEDATA.USER_PWD_RESET_WAIT_TIME, value: pwdWaitTime },
    ]),
    _user_ev(UserPasswordChangeRequest),
    _user_email('changePassword'),
  );
}

export async function confirmPasswordReset(identifier: number | string | User, newPassword: string, token: string) {
  return _chain(
    _user(identifier),
    _tap((u: User) =>
      _chain(u, _zip(_get_user_meta(USER_COMMON_MEDATA.USER_PWD_RESET_START_DATE), _get_user_meta(USER_COMMON_MEDATA.USER_PWD_RESET_WAIT_TIME)), ([dueDate, waitTime]: [DateTime, number]) => {
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
      _chain(u, _get_user_meta(USER_COMMON_MEDATA.USER_PWD_RESET_TOKEN), async (resetToken: string) => {
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

export async function changePassword(password: string): Promise<(u: User) => Promise<User>> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  return async (u: User) => {
    return _chain(
      _use(_service<PasswordProvider>('rbac.password'), 'pwd'),
      _use(_service<PasswordValidationProvider>('rbac.password.validation'), 'validator'),

      _tap(async ({ validator }: { validator: PasswordValidationProvider }) => {
        if (!validator.check(password)) {
          throw new Error('Password does not meet requirements');
        }
      }),

      // update password
      ({ pwd }: { pwd: PasswordProvider }) => pwd.hash(password),
      (hPassword: string) => _chain(u, _update<User>({ Password: hPassword }), _set_user_meta('/^user:pwd_reset/'), _user_ev(UserPasswordChanged)),
    );
  };
}

export async function auth(identifier: number | string | User, password: string): Promise<(u: User) => Promise<User>> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  return _chain(
    _user(identifier),
    _tap((u: User) =>
      _chain(_service<AuthProvider>('rbac.auth.service'), async (sAuth: AuthProvider) => {
        const result = await sAuth.authenticate(u.Email, password);
        if (!result.User) {
          throw new ErrorCode(E_CODES.E_NOT_LOGGED, `User not found`, { identifier });
        }
      }),
    ),
    _update<User>({ LastLoginAt: DateTime.now() }),
    _user_ev(UserLogged),
  );
}