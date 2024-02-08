import { DateTime } from 'luxon';
import { _update } from '@spinajs/orm';
import { v4 as uuidv4 } from 'uuid';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserLogged, UserPasswordChangeRequest, UserPasswordChanged, UserRoleGranted, UserUnbanned } from '../events/index.js';
import { _chain, _catch, _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _or, _is_string, _to_int, _default, _is_uuid, _max_length, _min_length } from '@spinajs/util';
import { AuthProvider, PasswordProvider, PasswordValidationProvider } from '../interfaces.js';
import _ from 'lodash';
import { _cfg, _service } from '@spinajs/configuration';
import { _email_deferred } from '@spinajs/email';
import { _user } from './fp.js';
import { USER_COMMON_MEDATA, User } from './models/User.js';
import { _ev } from '@spinajs/queue';
import { InvalidOperation } from '@spinajs/exceptions';

function _clearMeta(meta: string) {
  return async (u: User) => {
    u.Metadata[meta] = null;
    await u.Metadata.sync();
    return u;
  };
}

export async function activate(identifier: number | string) {
  return _chain<void>(
    _user(identifier),
    _update<User>({ IsActive: true }),
    _catch(
      (u: User) => _ev(new UserActivated(u.Uuid)),
      (err: Error) => console.log(err),
    ),
  );
}

export async function deactivate(identifier: number | string): Promise<void> {
  _chain(
    _user(identifier),
    _update<User>({ IsActive: false }),
    _catch(
      (u: User) => _ev(new UserDeactivated(u.Uuid)),
      (err: Error) => console.log(err),
    ),
  );
}

export async function create(email: string, login: string, password: string, roles: string[]): Promise<User> {
  const sPassword = await _service<PasswordProvider>('rbac.password');
  const dRole = await _cfg<string>('rbac.defaultRole');
  const { emailConfirmationCreation, emailTemplate } = await _cfg<{ emailConfirmationCreation: boolean; emailTemplate: string }>('rbac.creation')();

  email = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(email, 'email');
  login = _check_arg(_trim(), _non_empty(), _max_length(64))(login, 'login');
  roles = _check_arg(_default([dRole]))(roles, 'roles');
  password = await _check_arg(
    _trim(),
    _default(() => sPassword.generate()),
  )(password, 'password');

  const hPassword = await sPassword.hash(password);

  return _chain(
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
    (u: User) => u.insert().then(() => u),
    async (u: User) => {
      await _ev(new UserCreated(u.toJSON()));
      return u;
    },
    async (u: User) => {
      if (emailConfirmationCreation) {
      }
    },
  );
}

export async function deleteUser(identifier: number | string): Promise<User> {
  return _chain(
    _user(identifier),
    (u: User) => u.destroy(),
    (u: User) => _ev(new UserDeleted(u.Uuid)),
  );
}

export async function grant(identifier: number | string, role: string): Promise<User> {
  return _chain(
    _user(identifier),
    (u: User) =>
      u.update({
        Role: _.uniq([...u.Role, role]),
      }),
    (u: User) => _ev(new UserRoleGranted(u.Uuid, role)),
  );
}

export async function revoke(identifier: number | string, role: string): Promise<User> {
  return _chain(
    _user(identifier),
    (u: User) =>
      u.update({
        Role: u.Role.filter((r) => r !== role),
      }),
    (u: User) => _ev(new UserRoleGranted(u.Uuid, role)),
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
    async (u: User) => {
      u.Metadata[USER_COMMON_MEDATA.USER_BAN_DURATION] = duration;
      u.Metadata[USER_COMMON_MEDATA.USER_BAN_REASON] = reason;
      u.Metadata[USER_COMMON_MEDATA.USER_BAN_IS_BANNED] = true;
      u.Metadata[USER_COMMON_MEDATA.USER_BAN_START_DATE] = DateTime.now();

      await u.Metadata.sync();

      return u;
    },
    (u: User) => _ev(new UserBanned(u.Uuid)),
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
    async (u: User) => {
      u.Metadata['/^user:ban/'] = null;
      await u.Metadata.sync();
      return u;
    },
    (u: User) => _ev(new UserUnbanned(u.Uuid)),
  );
}

export async function updateUser(identifier: number | string | User, data: Partial<User>): Promise<User> {
  return _chain(_user(identifier), _update(data), (u: User) => _ev(new UserChanged(u.Uuid)));
}

export async function passwordChangeRequest(identifier: number | string | User): Promise<User> {
  return _chain(
    _user(identifier),
    async (u: User) => {
      u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_START_DATE] = DateTime.now();
      u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_TOKEN] = uuidv4();

      // 1h wait time
      u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_WAIT_TIME] = 60 * 60;

      await u.Metadata.sync();

      return u;
    },
    (u: User) => _ev(new UserPasswordChangeRequest(u.Uuid)),
    () => Promise.resolve(true),
  );
}

export async function confirmPasswordReset(identifier: number | string | User, newPassword: string, token: string) {
  return _chain(
    _user(identifier),
    async (u: User) => {
      const dueDate: DateTime = u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_START_DATE];

      if (dueDate < DateTime.now()) {
        throw new InvalidOperation(`Password change token expired, token expiration date is: ${dueDate.toISO()}`);
      }

      if (u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_TOKEN] !== token) {
        throw new InvalidOperation(`Password change token invalid, operation not permitted`);
      }
      return u;
    },
    async (u: User) => changePassword(u, newPassword),
    _clearMeta('/^user:pwd_reset/'),
    () => Promise.resolve(true),
  );
}

export async function changePassword(identifier: number | string | User, password: string): Promise<User> {
  const sPassword = await _service<PasswordProvider>('rbac.password');
  const sPwdValidator = await _service<PasswordValidationProvider>('rbac.password.validation');

  password = await _check_arg(_trim(), _non_empty())(password, 'password');

  if (!sPwdValidator.check(password)) {
    throw new Error('Password does not meet requirements');
  }

  return _chain(
    _user(identifier),

    // update password
    _update<User>({
      Password: await sPassword.hash(password),
    }),

    // clear all password reset metadata
    async (u: User) => {
      u.Metadata['/^user:pwd_reset/'] = null;
      await u.Metadata.sync();
      return u;
    },

    // notify others
    (u: User) => _ev(new UserPasswordChanged(u.Uuid)),
  );
}

export async function auth(identifier: string | number | User, password: string): Promise<User> {
  const sAuth = await _service<AuthProvider>('rbac.auth.service');

  return _chain(
    _user(identifier),
    async (u: User) => {
      const result = await sAuth.authenticate(u.Email, password);

      if (result.User) {
        return result.User;
      }

      throw result.Error;
    },
    _update<User>({ LastLoginAt: DateTime.now() }),
    (u: User) => _ev(new UserLogged(u.Uuid, DateTime.now())),
  );
}
