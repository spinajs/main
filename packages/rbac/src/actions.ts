import { _insert, _update } from '@spinajs/orm';
import { _use, _zip, _tap, _chain, _catch, _check_arg, _gt, _non_nil, _either, _is_email, _non_empty, _trim, _is_number, _or, _is_string, _to_int, _default, _is_uuid, _max_length, _min_length, _non_null, _to_array } from '@spinajs/util';
import _ from 'lodash';
import { _email_deferred } from '@spinajs/email';
import { _ev } from '@spinajs/queue';
import { USER_COMMON_METADATA, USER_SECURITY_METADATA_KEYS, User, UserBase } from './models/User.js';
import { _cfg, _service } from '@spinajs/configuration';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserLogged, UserPasswordChangeRequest, UserPasswordChanged, UserRoleGranted, UserRoleRevoked, UserUnbanned } from './events/index.js';
import { Constructor, DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UserEvent } from './events/UserEvent.js';
import { AthenticationErrorCodes, AuthProvider, PasswordProvider, PasswordValidationProvider, SessionProvider } from './interfaces.js';
import { DateTime } from 'luxon';
import { ErrorCode, InvalidArgument } from '@spinajs/exceptions';
import { AccessControl } from 'accesscontrol';
import { createHash, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { UserLoginFailed } from './events/UserLoginFailed.js';
import { UserMetadataChange } from './events/UserMetadataChange.js';
import { UserPasswordExpired } from './events/UserPasswordExpired.js';
import { userModel } from './model-token.js';

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

/**
 *
 * Gets system user account
 *
 * @returns system user
 */
export function _get_system_user() {
  return _chain(
    _zip(_cfg<string>('rbac.systemRole'), _cfg<string>('rbac.roleColumn')),
    ([systemRole, roleColumn]: [string, string]) => {
      const s = _check_arg(_trim(), _non_empty())(systemRole, 'rbac.systemRole');
      const c = _check_arg(_trim(), _non_empty())(roleColumn, 'rbac.roleColumn');

      return [s, c];
    },
    ([systemRole, roleColumn]: [string, string]) => User.query().where(roleColumn, systemRole).firstOrFail(), // base User on purpose: system account must resolve inside scoped request contexts
  );
}

/**
 *
 * Gets users by role helper func.
 *
 * @param role user role
 * @returns
 */
export function _get_users_by_role(role: string[]) {
  return () => userModel().select().withRole(role);
}

/**
 *
 * Gets rbac user model
 *
 * @param user
 * @returns
 */
export function _get_user(user: User | number | string) {
  if (_.isString(user)) {
    return async () => userModel().where('Uuid', user).firstOrFail();
  }

  if (_.isNumber(user)) {
    return async () => userModel().getOrFail(user);
  }

  return () => Promise.resolve(user);
}

/**
 * Sets metadata key-value pairs on a user.
 * Accepts either an array of `{ key, value }` objects or a single metadata key string with a separate value.
 * Emits a {@link UserMetadataChange} event after the metadata is persisted.
 *
 * @param meta - metadata key (string) or array of `{ key, value }` entries to set
 * @param value - value to assign when `meta` is a single key string (default: `null`)
 * @returns a function that receives a {@link User} and returns the updated user
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

/**
 * Retrieves a single metadata value from a user by key.
 * Throws if the user's metadata has not been populated or the requested key does not exist.
 *
 * @param key - metadata key to retrieve
 * @returns a function that receives a {@link User} and returns the metadata value
 */
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
 * @param cfgTemplate - which `rbac.email.*` entry describes the message
 * @param model - extra template variables merged over the user's own fields.
 *   Given as a FUNCTION of the user so a caller can compute them from the row it
 *   has just written ( the password-reset token is the case that needs it ).
 *   Nothing here is persisted and nothing is logged: whatever it carries goes
 *   straight into the rendered message.
 * @returns
 */
export function _user_email(
  cfgTemplate: 'changePassword' | 'created' | 'confirm' | 'deactivated' | 'activated' | 'deleted' | 'unbanned' | 'banned' | 'passwordWillExpire' | 'passwordExpired',
  model?: (u: User) => Promise<{ [key: string]: unknown }> | { [key: string]: unknown },
) {
  interface _tCfg {
    enabled: boolean;
    template: string;
    subject: string;
  }

  // NOTE: tap semantics - the user flows through, the email send result is
  // deliberately discarded. Actions end with this step and must resolve with
  // the User, not with an EmailSend job.
  return async (u: User) => {
    const extra = model ? await model(u) : undefined;

    await _chain<void>(_use(_cfg('rbac.email.connection', 'default'), 'connection'), _use(_cfg(`rbac.email.${cfgTemplate}`), 'template'), ({ connection, template }: { connection: string; template: _tCfg }) => {
      _check_arg(_non_nil(new ErrorCode(E_CODES.E_NO_EMAIL_TEMPLATE, `Email template ${cfgTemplate} not configured. Check rbac.email in config`)))(template, 'template');
      _check_arg(_is_string(_non_empty(), _max_length(128)))(template.template, 'email.template');
      _check_arg(_is_string(_non_empty(), _max_length(128)))(template.subject, 'email.subject');

      return (
        template.enabled &&
        _email_deferred({
          to: [u.Email],
          connection,
          model: { ...u.toJSON(), ...(extra ?? {}) },
          tag: `rbac-user-${cfgTemplate}`,
          template: template.template,
          subject: template.subject,
        })
      );
    });

    return u;
  };
}

/**
 * Emits a user-related event through the queue service.
 *
 * @param event - constructor of the {@link UserEvent} subclass to emit
 * @param args - additional arguments forwarded to the event constructor
 * @returns a function that receives a {@link User}, emits the event, and returns the user
 */
export function _user_ev(event: Constructor<UserEvent>, ...args: any[]) {
  return async (u: User) => {
    await _ev(new event(u, ...args))();
    return u;
  };
}

/**
 * Persists partial changes to a user record and emits a {@link UserChanged} event.
 *
 * @param data - optional partial user fields to merge into the existing record
 * @returns a function that receives a {@link User}, applies the update, and returns the user
 */
export function _user_update(data?: Partial<User>) {
  return async (u: User) => {
    await _chain(u, _update<User>(data), _user_ev(UserChanged));
    return u;
  };
}

/**
 * Resolves a user by identifier with metadata populated.
 * If a {@link User} instance is passed it is returned as-is; otherwise the user is
 * looked up by id, uuid, email, or login and its metadata relation is populated.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @returns a thunk that resolves to the {@link User}
 */
export function _user(identifier: number | string | User): () => Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof User) {
    return () => Promise.resolve(id);
  }

  return () => userModel().query().whereAnything(id).populate('Metadata').firstOrFail();
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

  return () => UserBase.query().whereAnything(id).populate('Metadata').firstOrFail();
}

/**
 * Destroys every session belonging to a user, on every device.
 *
 * Called from each action that invalidates what a live session was granted on:
 * a password change or reset ( the credential behind the session is gone ), a
 * ban or a deactivation ( the account may no longer act at all ). Without this
 * an attacker who is already inside keeps their session while the victim
 * changes the password that was supposed to lock them out.
 *
 * Errors are NOT swallowed: a session store that cannot be reached means the
 * revocation did not happen, and the caller must learn that rather than be told
 * the account is secure.
 *
 * @param user - the user whose sessions are destroyed, or their numeric id
 */
export async function revokeUserSessions(user: User | number): Promise<void> {
  const userId = _.isNumber(user) ? user : user?.Id;

  if (!userId) {
    return;
  }

  const provider = await _service('rbac.session', SessionProvider)();
  await provider.deleteByUser(userId);
}

/**
 * Chain step form of {@link revokeUserSessions} — revokes and forwards the user.
 */
function _revoke_sessions() {
  return async (u: User) => {
    await revokeUserSessions(u);
    return u;
  };
}

/**
 * ===============================================
 * USER ACTIONS
 * ===============================================
 */

/**
 * Activates a user account.
 * Sets `IsActive` to `true`, emits a {@link UserActivated} event, and sends the activation email.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function activate(identifier: number | string | User): Promise<User> {
  return _chain(_user(identifier), _user_update({ IsActive: true }), _user_ev(UserActivated), _user_email('activated'));
}

/**
 * Deactivates a user account.
 * Sets `IsActive` to `false`, emits a {@link UserDeactivated} event, and sends the deactivation email.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function deactivate(identifier: number | string | User): Promise<User> {
  // Sessions go with the account: a deactivated user must stop acting NOW, not
  // whenever their session happens to expire.
  return _chain(_user(identifier), _user_update({ IsActive: false }), _revoke_sessions(), _user_ev(UserDeactivated), _user_email('deactivated'));
}

/**
 * Middleware signature used by the `create` action's `beforeCreate` / `afterCreate` hooks.
 */
export type CreateMiddleware = (u: User) => Promise<User> | User;

/**
 * Reads a create-middleware list from configuration.
 * An unset or empty `beforeCreate` / `afterCreate` list is a valid
 * "no middleware" result ( `_cfg` accepts empty arrays ).
 */
function _create_middleware(path: string): CreateMiddleware[] {
  const mw = _cfg<CreateMiddleware[]>(path, [])();
  return Array.isArray(mw) ? mw : [];
}

/**
 * Optional inputs of the {@link create} action.
 */
export interface ICreateUserOptions {
  /**
   * Plain-text password. Omit it and a random one is generated, the account is
   * handed to its owner by a password-reset link, and the generated value is
   * returned for a caller that needs it ( the CLI prints it ).
   */
  password?: string;

  /** Explicit user id. Useful when migrating accounts from another system. */
  id?: number;

  /** Key-value metadata attached to the new account. */
  metadata?: { [key: string]: any };
}

/**
 * Refuses a login / email already taken by another account.
 *
 * Exported because uniqueness is not only a creation-time rule: an update that
 * renames an account has to apply exactly the same one, and a second
 * implementation of it would be a second thing to keep in step. `exceptUserId`
 * is what an update passes so an account does not clash with itself.
 *
 * Queries the base {@link User} rather than `userModel()`: uniqueness is GLOBAL,
 * and an application's scoped subclass would hide the clashing row — turning a
 * clean refusal into a driver error on the unique index.
 *
 * Soft-deleted rows are included for the same reason. They still occupy the
 * unique indexes, so ignoring them trades this error for that driver error.
 *
 * The thrown {@link ErrorCode} carries `fields`, naming WHICH of login / email
 * clashed, so an http caller can mark the offending input rather than reporting
 * that something, somewhere, is already in use.
 *
 * @param login - login to check, or undefined to skip the login check
 * @param email - email to check, or undefined to skip the email check
 * @param exceptUserId - id of the account being updated, which may keep its own values
 */
/**
 * The roles a request denotes, whether it arrives as one name or a list.
 *
 * Trimmed, stripped of blanks and de-duplicated. Order is preserved so a caller
 * that treats the first entry as the primary role keeps that meaning.
 *
 * De-duplication is not cosmetic: every downstream guard is charged per entry,
 * so `['user', ' user ']` costs two checks for one role.
 *
 * @param role - a single role name or a list of them
 */
export function roleList(role?: string | string[]): string[] {
  if (role === undefined || role === null) {
    return [];
  }

  const wanted = (Array.isArray(role) ? role : [role]).map((r) => String(r ?? '').trim()).filter((r) => r.length > 0);

  return [...new Set(wanted)];
}

/**
 * Refuses a role the application has not configured.
 *
 * A role counts as configured if it either holds grants in the resolved
 * {@link AccessControl} instance or is merely declared in `rbac.roles` - the
 * same definition of "known" `DefaultRoleGuard` (`@spinajs/rbac-http-admin`)
 * already uses for its own route-level check. A role may legitimately be named
 * before it is given any permission, and a narrower definition here would
 * refuse a role the route layer of this same codebase already accepts.
 * `hasRole` resolves roles defined only through `$extend`, so an
 * inheritance-only role such as `system` is recognised.
 *
 * `rbac.requireKnownRole: false` turns the whole check off - see the comment
 * at its first use below.
 *
 * @param roles - role names to check; every unknown name is reported at once
 */
export function assertRolesExist(roles: string[]): void {
  // An application whose roles are defined at runtime rather than in static
  // config turns this off wholesale. `rbac-http-admin`'s DefaultRoleGuard has
  // carried the same escape hatch for its own route-level check since before
  // this one existed; a library-level check that could not be turned off would
  // make rbac unusable for those applications.
  if (_cfg('rbac.requireKnownRole', true)() === false) {
    return;
  }

  const ac = DI.get<AccessControl>('AccessControl');

  if (!ac) {
    // No grants loaded at all means the application has not configured rbac, not
    // that every role is invalid - refusing here would break bootstrap ordering.
    return;
  }

  // "Known" the same way DefaultRoleGuard already means it: holding grants, or
  // merely DECLARED. A role may legitimately be named before it is given any
  // permission, and a narrower definition here would refuse roles the route
  // layer of this same codebase already accepts.
  //
  // Guarded the way DefaultRoleGuard guards the same list: `rbac.roles` may be
  // assembled dynamically, and one malformed entry must not turn every create()
  // in the application into an unhandled TypeError. An entry without a `Name`
  // simply never matches a real role.
  const configured = _cfg<Array<{ Name: string }>>('rbac.roles', [])();
  const declared = (Array.isArray(configured) ? configured : []).map((r) => r?.Name).filter(Boolean);

  const unknown = roles.filter((r) => !ac.hasRole(r) && !declared.includes(r));

  if (unknown.length > 0) {
    throw new InvalidArgument(`Role(s) not configured in rbac.grants or rbac.roles: ${unknown.join(', ')}`, 'roles');
  }
}

/**
 * Refuses metadata keys that decide account access.
 *
 * `user:pwd_reset:token` is a bearer credential redeemable at the PUBLIC reset
 * endpoint and `user:2fa:*` is the second factor itself — writing either through
 * a generic key-value merge hands out an account rather than annotating one.
 * Ban and lockout keys are refused for the same reason bans have their own
 * action: written directly they skip the event, the email and the session
 * revocation that make a ban mean something.
 *
 * Lives here rather than in one http controller because the keys it protects are
 * rbac's own, and an account seeded with a known reset token is an account
 * takeover no matter which caller planted it — a CLI, a migration and a route
 * all need the same refusal.
 *
 * @param metadata - the key-value bag a caller wants attached to an account
 */
export function assertNoProtectedMetadata(metadata?: { [key: string]: any }): void {
  if (!metadata) {
    return;
  }

  const offending = Object.keys(metadata).filter((key) => {
    // A glob reaches the metadata relation's setter as a PATTERN and rewrites
    // every matching entry, so `*` alone would overwrite the whole set —
    // including the protected keys listed above.
    if (key.includes('*') || key.includes('?')) {
      return true;
    }

    return USER_SECURITY_METADATA_KEYS.includes(key);
  });

  if (offending.length > 0) {
    throw new InvalidArgument(`Protected metadata keys cannot be set directly: ${offending.join(', ')}`);
  }
}

export async function assertUserUnique(login?: string, email?: string, exceptUserId?: number): Promise<void> {
  const clashes: string[] = [];

  if (login) {
    const found = await User.query().withDeleted().where('Login', login).first();
    if (found && found.Id !== exceptUserId) {
      clashes.push('Login');
    }
  }

  if (email) {
    const found = await User.query().withDeleted().where('Email', email).first();
    if (found && found.Id !== exceptUserId) {
      clashes.push('Email');
    }
  }

  if (clashes.length > 0) {
    throw new ErrorCode(E_CODES.E_USER_ALREADY_EXISTS, `${clashes.join(' and ')} already in use`, { fields: clashes });
  }
}

/**
 * Creates a new user account.
 *
 * Validates and normalises inputs, refuses a duplicate login / email and
 * protected metadata keys, hashes the password, inserts the user record,
 * optionally sets metadata, runs configured `beforeCreate` / `afterCreate`
 * middleware, emits a {@link UserCreated} event, and sends the "created" email.
 *
 * When no password is given, one is generated AND a password-reset link is
 * mailed to the address. Those two are one decision, not two: a generated
 * password is a secret nobody knows, so an account created without the reset
 * link is an account with no way in at all. Callers that pass a password know
 * it and own delivery themselves, so they get no link — which is what a CLI
 * service account or a fixture wants.
 *
 * @param email - user email address (max 64 chars)
 * @param login - user login name (max 32 chars)
 * @param roles - array of role names to assign
 * @param options - see {@link ICreateUserOptions}
 * @returns an object containing the persisted {@link User} and the plain-text password
 */
export async function create(email: string, login: string, roles: string[], options?: ICreateUserOptions): Promise<{ User: User; Password: string }> {
  const sPassword = await _service<PasswordProvider>('rbac.password', PasswordProvider)();

  // Whether the CALLER supplied a password decides who hands the account to its
  // owner, so it is read before `_default` fills a generated one in and the two
  // cases become indistinguishable.
  const generated = _check_arg(_trim(), _default(''))(options?.password, 'password') === '';

  email = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(email, 'email');
  login = _check_arg(_trim(), _non_empty(), _max_length(32))(login, 'login');

  const roleNames = roleList(roles);

  if (roleNames.length === 0) {
    throw new InvalidArgument('At least one role must be given', 'roles');
  }

  assertRolesExist(roleNames);

  const password = _check_arg(
    _trim(),
    _default(() => sPassword.generate()),
  )(options?.password, 'password');

  // Only the SUPPLIED branch is checked. A generated password is asserted
  // against the same rule inside `generate()`, and re-checking it here would
  // only re-report a configuration fault as a caller mistake.
  if (!generated) {
    const validator = await _service<PasswordValidationProvider>('rbac.password.validation', PasswordValidationProvider)();

    if (!validator.check(password)) {
      throw new InvalidArgument('Password does not meet requirements', 'password');
    }
  }

  const hPassword = await sPassword.hash(password);
  const id = options?.id;
  const metadata = options?.metadata;

  return _chain(
    // Ahead of everything else, and ahead of `beforeCreate` in particular: a
    // request that is about to be refused must not first run middleware that
    // writes to another system ( the legacy-user mirror is one ).
    _tap(() => assertNoProtectedMetadata(metadata)),
    _tap(() => assertUserUnique(login, email)),

    // create user
    () =>
      Promise.resolve(
        new User({
          Id: id,
          Email: email,
          Login: login,
          Password: hPassword,
          Role: roleNames,
          RegisteredAt: DateTime.now(),
          CreatedAt: DateTime.now(),
          IsActive: false,
          Uuid: uuidv4(),
        }),
      ),

    // run before create middleware
    (u: User) => _chain(u, ..._create_middleware('rbac.actions.create.beforeCreate')),

    // insert to db
    _insert(),

    _either(
      () => metadata !== undefined,
      _set_user_meta(metadata ? Object.entries(metadata).map(([key, value]) => ({ key, value })) : []),
      async (u: User) => u,
    ),

    // run after create middleware
    (u: User) => _chain(u, ..._create_middleware('rbac.actions.create.afterCreate')),

    // send event
    _user_ev(UserCreated, (u: User) => u.toJSON()),

    // send email
    _tap(_user_email('created')),

    // Hand the account to its owner when nobody else can: the password above was
    // invented here and immediately hashed, so without this the account is
    // unreachable until an administrator remembers a second screen.
    //
    // AFTER the "created" email so the two arrive in the order they are meant to
    // be read, and BY UUID rather than by the instance in hand — the reset writes
    // three metadata entries, and `_user()` re-reads with `Metadata` populated,
    // which an instance built by `new User(...)` never is. Handing it the
    // instance stored nothing, silently, and left the account with no token.
    //
    // Swallowed on purpose: the account EXISTS by now. Throwing would tell the
    // caller creation failed when it did not, inviting a retry that then fails on
    // the duplicate login. A link that could not be issued can be re-sent.
    _tap(async (u: User) => {
      if (!generated) {
        return;
      }

      await _catch(
        () => passwordChangeRequest(u.Uuid),
        (err: Error) => {
          DI.resolve(Log, ['rbac']).error(err, `Could not issue the initial password reset for ${u.Uuid}. The account exists but its owner has no way in yet.`);
        },
      )();
    }),

    // return user & password - if generated we want to know not hashed password
    (u: User) => {
      return { User: u, Password: password };
    },
  );
}

/**
 * Permanently deletes a user from the database.
 * Emits a {@link UserDeleted} event and sends the "deleted" email.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function deleteUser(identifier: number | string | User): Promise<void> {
  return _chain(
    _user(identifier),
    _tap((u: User) => u.destroy()),

    // Same reason a deactivation revokes: the account may no longer act. A live
    // session outlasting the deletion is worse here than there — the session
    // middleware resolves its user through `isActiveUser()`, which no longer
    // matches a soft-deleted row, so every request from that session dies in
    // the middleware instead of being cleanly logged out.
    _revoke_sessions(),

    _user_ev(UserDeleted),
    _user_email('deleted'),
  );
}

/**
 * Grants an additional role to a user.
 * The role is added only if not already present. Emits a {@link UserRoleGranted} event.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param role - role name to grant
 * @returns the updated {@link User}
 */
export async function grant(identifier: number | string | User, role: string): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  // A role you cannot create an account with must not be one you can add
  // afterwards - otherwise grant is a way around the creation check.
  assertRolesExist([role]);

  return _chain(
    _user(identifier),
    _tap(async (u: User) => (u.Role = _.uniq([...u.Role, role]))),
    _user_update(),
    _user_ev(UserRoleGranted, role),
  );
}

/**
 * Revokes a role from a user.
 * Removes the role from the user's role list and emits a {@link UserRoleRevoked} event.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param role - role name to revoke
 * @returns the updated {@link User}
 */
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

    // A ban that leaves the banned user's session alive bans nothing until that
    // session expires — `isActiveUser` does not filter on the ban flag, so the
    // session would keep resolving happily.
    _revoke_sessions(),

    _user_ev(UserBanned),
    _user_email('banned'),
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

    // guard must return the user so the chain can keep flowing it downstream
    _tap(async (u: User) => {
      if (!u.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]) {
        throw new ErrorCode(E_CODES.E_USER_BANNED, `User is already unbanned`, { user: u });
      }
    }),

    // actually remove the ban metadata from the DB. Assigning a regex-like
    // string key never cleared anything; delete() removes each key from store.
    _tap(async (u: User) => {
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_IS_BANNED);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_START_DATE);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_DURATION);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_REASON);
    }),

    _user_ev(UserUnbanned),
  );
}

/**
 * Builds the link a reset mail sends the user to.
 *
 * `rbac.password.resetUrl` is the application's own redemption page. The token
 * and the address are appended as query parameters because that page has to send
 * both back to `POST /auth/password/reset`, and it has no other way of knowing
 * them. Returns an empty string when no url is configured — the template then
 * renders whatever it does without one, rather than a link to nowhere.
 */
async function _pwd_reset_url(email: string, token: string): Promise<string> {
  const base = await _cfg<string>('rbac.password.resetUrl', '')();

  if (!base) {
    return '';
  }

  const url = new URL(base);
  url.searchParams.set('token', token);
  url.searchParams.set('email', email);

  return url.toString();
}

/**
 * Initiates a password-change request for a user.
 * Generates a reset token, stores it along with the current timestamp and configured
 * wait time in the user's metadata, emits a {@link UserPasswordChangeRequest} event and
 * sends the `changePassword` mail carrying the token.
 *
 * THE MAIL IS THE POINT. The token is issued into metadata and never returned over HTTP —
 * possession of the mailbox is what authorizes the reset — so an installation that does not
 * deliver it has a reset flow nobody can complete. It used to be the application's job, via
 * the event, and every application that had not written that subscriber silently issued
 * tokens into the void. `rbac.email.changePassword.enabled: false` still turns it off for an
 * application that really does deliver it some other way.
 *
 * The token reaches the template through the model and is NOT logged: it is a bearer
 * credential for `POST /auth/password/reset`.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function passwordChangeRequest(identifier: number | string | User) {
  const pwdWaitTime = await _cfg<number>('rbac.password.passwordResetWaitTime')();
  const token = uuidv4();

  return _chain(
    _user(identifier),
    _set_user_meta([
      { key: USER_COMMON_METADATA.USER_PWD_RESET_START_DATE, value: DateTime.now() },
      { key: USER_COMMON_METADATA.USER_PWD_RESET_TOKEN, value: token },
      { key: USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME, value: pwdWaitTime },
    ]),
    _user_ev(UserPasswordChangeRequest),
    _tap(
      _user_email('changePassword', async (u: User) => ({
        Token: token,
        ResetUrl: await _pwd_reset_url(u.Email, token),
        // Minutes rather than the raw seconds: a template writes "the link is
        // valid for X minutes", and doing the arithmetic in a handlebars
        // expression is not something every template engine can do.
        ExpiresInMinutes: Math.round(pwdWaitTime / 60),
      })),
    ),
  );
}

/**
 * Confirms a password reset by validating the token and expiration, then changing the password.
 * Throws if the token has expired or does not match the stored value.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param newPassword - the new plain-text password to set
 * @param token - the reset token that was issued by {@link passwordChangeRequest}
 */
export async function confirmPasswordReset(identifier: number | string | User, newPassword: string, token: string) {
  return _chain(
    _user(identifier),

    // A reset must not resurrect an account that is banned, deactivated or
    // deleted — otherwise the reset flow is a way around every one of those
    // states. Same ErrorCode family the caller already collapses into one
    // opaque failure, so this does not become an account-state oracle.
    _tap(async (u: User) => {
      if (u.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]) {
        throw new ErrorCode(E_CODES.E_USER_BANNED, `Password reset refused: user is banned`, { user: u });
      }

      if (!u.IsActive || u.DeletedAt) {
        throw new ErrorCode(E_CODES.E_USER_NOT_ACTIVE, `Password reset refused: user is not active`, { user: u });
      }
    }),

    _tap((u: User) =>
      _chain(u, _zip(_get_user_meta(USER_COMMON_METADATA.USER_PWD_RESET_START_DATE), _get_user_meta(USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME)), ([dueDate, waitTime]: [DateTime, number]) => {
        if (dueDate.plus({ seconds: waitTime }) < DateTime.now()) {
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
        if (!_secure_compare(String(resetToken), token)) {
          throw new ErrorCode(E_CODES.E_TOKEN_INVALID, `Password change token invalid, operation not permitted`, {
            token,
            resetToken,
            user: u,
          });
        }
      }),
    ),
    changePassword(newPassword),

    // Burn the token. Validating it and leaving it in place made it a
    // multi-use credential for the whole `passwordResetWaitTime` window:
    // anyone who saw the reset mail once could keep re-taking the account.
    _tap(async (u: User) => {
      await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_TOKEN);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_START_DATE);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET);
    }),
  );
}

/**
 * Length-independent, constant-time string comparison for secrets.
 *
 * `!==` on a token leaks how many leading characters matched through timing.
 * The margin is small over a network and the tokens are uuid-shaped, but a
 * comparison of a secret is the wrong place to rely on that.
 *
 * @param a - value read from storage
 * @param b - value supplied by the caller
 */
function _secure_compare(a: string, b: string): boolean {
  const ha = createHash('sha256')
    .update(a ?? '')
    .digest();
  const hb = createHash('sha256')
    .update(b ?? '')
    .digest();

  // hashing first makes both operands the same length, which timingSafeEqual
  // requires and which also stops the length itself from leaking
  return timingSafeEqual(ha, hb);
}

/**
 * Returns a function that changes a user's password.
 * The new password is validated against the configured {@link PasswordValidationProvider},
 * hashed via the configured {@link PasswordProvider}, persisted, and a
 * {@link UserPasswordChanged} event is emitted.
 *
 * @param password - new plain-text password
 * @returns a function that receives a {@link User} and returns the updated user
 */
export function changePassword(password: string): (u: User) => Promise<User> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  return async (u: User) => {
    return _chain(
      _use(_service('rbac.password', PasswordProvider), 'pwd'),
      _use(_service('rbac.password.validation', PasswordValidationProvider), 'validator'),

      _tap(async ({ validator }: { validator: PasswordValidationProvider }) => {
        if (!validator.check(password)) {
          // `InvalidArgument`, not a bare `Error`: a password the caller typed is
          // invalid INPUT, and @spinajs/http maps this class to 400 ( BadRequestResponse
          // via `@HandleException` ) while an unmapped error becomes a 500. Every route
          // that lets a user pick a password - `PATCH /user/password`, the reset flow -
          // answered "internal server error" for a password that was merely too weak,
          // which reads to the user as a broken screen rather than as a rule they can
          // satisfy. The field name and error code travel in the response body ( the
          // error handler spreads the exception's own enumerable props ), so a client
          // can point at the field and branch on the code instead of matching English.
          throw new InvalidArgument('Password does not meet requirements', 'password', E_CODES[E_CODES.E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS]);
        }
      }),

      // update password
      ({ pwd }: { pwd: PasswordProvider }) => pwd.hash(password),
      (hPassword: string) =>
        _chain(
          u,
          _update<User>({ Password: hPassword }),
          _set_user_meta([
            { key: USER_COMMON_METADATA.USER_PWD_RESET_LAST_ATTEMPT, value: DateTime.now().toISO() },

            // a successful password change clears the login throttle: the
            // credential the failures were counted against no longer exists
            { key: USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS, value: 0 },
            { key: USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL, value: null },
          ]),

          // Every session was authorized by the OLD password. Whoever holds one
          // — including whoever the user is changing the password because of —
          // loses it here. Callers that want the acting user to stay logged in
          // ( eg. PATCH /user/password ) mint a fresh session afterwards.
          _revoke_sessions(),

          _user_ev(UserPasswordChanged),
        ),
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
    // NOTE: _chain forwards exactly ONE value from step to step, so the second
    // parameter of the last step was always undefined and every call died with
    // "Cannot read properties of undefined (reading 'Password')" — including
    // the happy path of PATCH /user/password. The user is taken from the
    // closure instead.
    return await _chain(_service('rbac.password', PasswordProvider), async (sPwd: PasswordProvider) => sPwd.verify(u.Password, password));
  };
}

/**
 * Authenticates a user with the given password.
 * Delegates to the configured {@link AuthProvider}, updates `LastLoginAt`, and emits a
 * {@link UserLogged} event on success. On failure a {@link UserLoginFailed} event is emitted
 * and the original error is re-thrown.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param password - plain-text password to verify
 * @returns the authenticated {@link User}
 */
export async function login(identifier: number | string | User, password: string): Promise<User> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  return await _chain(
    _login_lookup(identifier),
    _catch(
      (u: User) => {
        return _chain(
          async () => {
            // Refuse before the password is even checked, so a locked account
            // cannot be probed at all during the lockout window.
            await _assert_not_locked(u);
            return _service('rbac.auth', AuthProvider)();
          },
          async (sAuth: AuthProvider) => sAuth.authenticate(u.Email, password),
          _update<User>({ LastLoginAt: DateTime.now() }),
          _clear_login_throttle(),
          _user_ev(UserLogged),
        );
      },
      (err, u: User) => {
        return _chain(
          () => u,

          // count the failure and lock the account once the configured
          // threshold is reached
          _register_failed_login(err),

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

/**
 * Resolves the user a login attempt names, answering an authentication failure
 * rather than an orm one when no such account exists.
 *
 * {@link _user_unsafe} ends in `firstOrFail()`, whose `OrmNotFoundException` is
 * neither `ErrorCode` nor `InvalidArgument`: the login controller cannot read it
 * as an authentication failure, so it rethrows and `@spinajs/orm-http` maps it to
 * a 404 while a wrong password answers 401. That difference is an
 * account-enumeration oracle — the status code alone tells a caller whether an
 * address is registered. Both cases carry `E_INVALID_CREDENTIALS`, exactly as
 * {@link SimpleDbAuthProvider.authenticate} already does for the password it
 * cannot verify.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User}
 */
function _login_lookup(identifier: number | string | User): () => Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof UserBase) {
    return () => Promise.resolve(id as User);
  }

  return () => UserBase.query().whereAnything(id).populate('Metadata').firstOrThrow(new ErrorCode(AthenticationErrorCodes.E_INVALID_CREDENTIALS, 'no user with given email'));
}

/**
 * Throws when the account is inside a lockout window opened by
 * {@link _register_failed_login}.
 *
 * @param u - user attempting to authenticate
 */
async function _assert_not_locked(u: User): Promise<void> {
  const raw = u?.Metadata?.[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL];

  if (!raw) {
    return;
  }

  const lockedUntil = raw instanceof DateTime ? raw : DateTime.fromISO(String(raw));

  if (lockedUntil.isValid && lockedUntil > DateTime.now()) {
    throw new ErrorCode(AthenticationErrorCodes.E_LOGIN_ATTEMPTS_EXCEEDED, `Too many failed login attempts, account is temporarily locked until ${lockedUntil.toISO()}`, {
      user: u,
      lockedUntil,
    });
  }
}

/**
 * Clears the failure counter and any expired lock after a successful login.
 */
function _clear_login_throttle() {
  return async (u: User) => {
    const meta = u?.Metadata;

    if (!meta) {
      return u;
    }

    const hasAttempts = Number(meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] ?? 0) > 0;
    const hasLock = Boolean(meta[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL]);

    if (!hasAttempts && !hasLock) {
      return u;
    }

    await meta.delete(USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS);
    await meta.delete(USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL);

    return u;
  };
}

/**
 * Records one failed authentication and, at `rbac.password.blockAfterAttempts`
 * consecutive failures, locks the account for `rbac.password.lockoutTime`
 * seconds.
 *
 * `blockAfterAttempts <= 0` disables throttling entirely. A rejection that was
 * itself the lockout is not counted — otherwise hammering a locked account
 * would keep extending the lock indefinitely.
 *
 * @param err - the error that ended the login attempt
 */
function _register_failed_login(err: unknown) {
  return async (u: User) => {
    const meta = u?.Metadata;

    if (!meta) {
      return u;
    }

    if (err instanceof ErrorCode && err.code === AthenticationErrorCodes.E_LOGIN_ATTEMPTS_EXCEEDED) {
      return u;
    }

    const blockAfter = await _cfg<number>('rbac.password.blockAfterAttempts', 5)();
    const lockoutTime = await _cfg<number>('rbac.password.lockoutTime', 15 * 60)();

    if (!blockAfter || blockAfter <= 0) {
      return u;
    }

    const attempts = Number(meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] ?? 0) + 1;

    if (attempts >= blockAfter) {
      meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] = 0;
      meta[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL] = DateTime.now().plus({ seconds: lockoutTime }).toISO();
    } else {
      meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] = attempts;
    }

    await meta.update();

    return u;
  };
}
