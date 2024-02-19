import { _update } from '@spinajs/orm';
import { _use, _tap, _chain, _catch, _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _or, _is_string, _to_int, _default, _is_uuid, _max_length, _min_length } from '@spinajs/util';
import _ from 'lodash';
import { _email_deferred } from '@spinajs/email';
import { _user } from './fp.js';
import { _ev } from '@spinajs/queue';
import { User } from './models/User.js';
import { _cfg, _service } from '@spinajs/configuration';
import { UserActivated, UserChanged, UserDeactivated, UserDeleted, UserLogged, UserPasswordChanged, UserRoleGranted, UserRoleRevoked } from './events/index.js';
import { Constructor } from '@spinajs/di';
import { UserEvent } from './events/UserEvent.js';
import { AuthProvider, PasswordProvider, PasswordValidationProvider } from './interfaces.js';
import { DateTime } from 'luxon';


function _clearMeta(meta: string) {
  return async (u: User) => {
    u.Metadata[meta] = null;
    await u.Metadata.sync();
    return u;
  };
}

/**
 * Helper function for sending user notification emails
 * Templates are defined in rbac configuration
 * 
 * @param cfgTemplate 
 * @returns 
 */
function _email(cfgTemplate: 'changePassword' | 'created' | 'confirm' | 'deactivated' | 'deleted' | 'unbanned' | 'banned'): (u: User) => Promise<User> {
  return async (u: User) => {
    return _chain(
      _use(_cfg('rbac.email.connection'), 'connection'),
      _use(_cfg(`rbac.email.${cfgTemplate}`), 'template'),
      ({ conn, tCfg }: {
        conn: string, tCfg: {
          enabled: boolean;
          template: string;
          subject: string;

        }
      }) => tCfg.enabled && _email_deferred({
        to: [u.Email],
        connection: conn,
        model: u.toJSON(),
        tag: `rbac-user-${cfgTemplate}`,
        template: tCfg.template,
        subject: tCfg.subject
      }),
    );
  }
}

function _user_ev(event: Constructor<UserEvent>, ...args: any[]) {
  return async (u: User) => {
    return _ev(new event(u, ...args));
  };
}

export function _update_user(data: Partial<User>) {
  return (u: User) => {
    return _chain(
      Promise.resolve(u),
      _update(data),
      _user_ev(UserChanged),
      true
    );
  }
}

export async function activate(identifier: number | string | User) {
  return _chain(
    _user(identifier),
    _update<User>({ IsActive: true }),
    _tap(_user_ev(UserActivated)),
    _email('created'),
    true
  );
}


export async function deactivate(identifier: number | string): Promise<void> {
  return _chain(
    _user(identifier),
    _update<User>({ IsActive: true }),
    _tap(_user_ev(UserDeactivated)),
    _email('deactivated'),
    true
  );
}

// export async function create(email: string, login: string, password: string, roles: string[]): Promise<User> {
//   const sPassword = await _service<PasswordProvider>('rbac.password')();

//   email = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(email, 'email');
//   login = _check_arg(_trim(), _non_empty(), _max_length(64))(login, 'login');
//   password = await _check_arg(
//     _trim(),
//     _default(() => sPassword.generate()),
//   )(password, 'password');

//   const hPassword = await sPassword.hash(password);

//   return _chain(
//     // create user 
//     () =>
//       Promise.resolve(
//         new User({
//           Email: email,
//           Login: login,
//           Password: hPassword,
//           Role: roles,
//           RegisteredAt: DateTime.now(),
//           IsActive: false,
//           Uuid: uuidv4(),
//         }),
//       ),

//     // insert to db
//     (u: User) => u.insert().then(() => u),

//     // send event to nitify others
//     async (u: User) => {
//       await _ev(new UserCreated(u.toJSON()));
//       return u;
//     },

//     // send email if needed
//     _email('confirm'),

//     // return user & password - if generated we want to know not hashed password
//     (u: User) => { return { User: u, Password: password } },
//   );
// }

export async function deleteUser(identifier: number | string): Promise<User> {
  return _chain(
    _user(identifier),
    (u: User) => u.destroy(),
    _user_ev(UserDeleted),
    _email('deleted'),
    true
  );
}

export async function grant(identifier: number | string, role: string): Promise<User> {

  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _user(identifier),
    (u: User) => _chain(u, _update_user({ Role: _.uniq([...u.Role, role]) })),
    _user_ev(UserRoleGranted, role),
    true
  );
}

export async function revoke(identifier: number | string | User, role: string): Promise<User> {

  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _user(identifier),
    (u: User) => _chain(u, _update_user({ Role: u.Role.filter((r) => r !== role) })),
    _user_ev(UserRoleRevoked, role),
    true
  );
}

// /**
//  *
//  * Bans user for specified time. If duration is 0 user is banned for 24h
//  *
//  * @param identifier user identifier one of : id, uuid, email, login
//  * @param reason reson for ban
//  * @param duration duration in seconds
//  * @returns
//  */
// export async function ban(identifier: number | string | User, reason?: string, duration?: number): Promise<User> {
//   duration = _check_arg(_default(24 * 60 * 60), _is_number(_gt(0)))(duration, 'duration');
//   reason = _check_arg(_default('NO_REASON'), _max_length(255))(reason, 'reason');

//   return _chain(
//     _user(identifier),
//     async (u: User) => {
//       u.Metadata[USER_COMMON_MEDATA.USER_BAN_DURATION] = duration;
//       u.Metadata[USER_COMMON_MEDATA.USER_BAN_REASON] = reason;
//       u.Metadata[USER_COMMON_MEDATA.USER_BAN_IS_BANNED] = true;
//       u.Metadata[USER_COMMON_MEDATA.USER_BAN_START_DATE] = DateTime.now();

//       await u.Metadata.sync();

//       return u;
//     },
//     (u: User) => _ev(new UserBanned(u.Uuid)),
//     _email('banned'),
//   );
// }

// /**
//  *
//  * Unba user
//  *
//  * @param identifier
//  * @returns
//  */
// export async function unban(identifier: number | string | User): Promise<User> {
//   return _chain(
//     _user(identifier),
//     async (u: User) => {
//       u.Metadata['/^user:ban/'] = null;
//       await u.Metadata.sync();
//       return u;
//     },
//     (u: User) => _ev(new UserUnbanned(u.Uuid)),
//     _email('unbanned'),
//   );
// }



// export async function passwordChangeRequest() {
//   return async (u: User) => {
//     return _chain(
//       Promise.resolve(u),
//       async (u: User) => {
//         u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_START_DATE] = DateTime.now();
//         u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_TOKEN] = uuidv4();

//         // 1h wait time
//         u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_WAIT_TIME] = 60 * 60;

//         await u.Metadata.sync();

//         return u;
//       },
//       (u: User) => _ev(new UserPasswordChangeRequest(u.Uuid)),
//       _email('changePassword'),
//       () => Promise.resolve(u),
//     );
//   }
// }

// export async function confirmPasswordReset(newPassword: string, token: string) {
//   return async (u: User) => {
//     return _chain(
//       Promise.resolve(u),
//       async (u: User) => {
//         const dueDate: DateTime = u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_START_DATE];

//         if (dueDate < DateTime.now()) {
//           throw new InvalidOperation(`Password change token expired, token expiration date is: ${dueDate.toISO()}`);
//         }

//         if (u.Metadata[USER_COMMON_MEDATA.USER_PWD_RESET_TOKEN] !== token) {
//           throw new InvalidOperation(`Password change token invalid, operation not permitted`);
//         }
//         return u;
//       },
//       changePassword(newPassword),
//       () => Promise.resolve(u),
//     );
//   }
// }

export async function changePassword(password: string): Promise<(u: User) => Promise<User>> {
  return async (u: User) => {

    _check_arg(_non_empty())(password, 'password');

    return _chain(
      _use(_service<PasswordProvider>('rbac.password'), 'pwd'),
      _use(_service<PasswordValidationProvider>('rbac.password.validation'), 'validator'),


      _tap(({ validator }: { validator: PasswordValidationProvider }) => {
        if (!validator.check(password)) {
          throw new Error('Password does not meet requirements');
        }
      }),

      // update password
      ({ pwd }: { pwd: PasswordProvider }) => pwd.hash(password),
      (hPassword: string) =>
        _chain(u,
          _update_user({ Password: hPassword }),
          _clearMeta('/^user:pwd_reset/'),
          _user_ev(UserPasswordChanged)
        ),
    );
  }
}

export async function auth(password: string): Promise<(u: User) => Promise<User>> {

  _check_arg(_non_empty())(password, 'password');

  return async (u: User) => {
    return _chain(
      _service<AuthProvider>('rbac.auth.service'),
      async (sAuth: AuthProvider) => {
        const result = await sAuth.authenticate(u.Email, password);
        if (!result.User) {
          throw result.Error;
        }
      },
      u,
      _update_user({ LastLoginAt: DateTime.now() }),
      _user_ev(UserLogged),
    );
  }
}


