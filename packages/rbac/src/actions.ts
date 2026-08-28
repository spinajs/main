import { insertModel, updateModel } from '@spinajs/orm';
import { _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _is_string, _default, _max_length, _toArray } from '@spinajs/util';
import _ from 'lodash';
import { emailDeferred } from '@spinajs/email';
import { ev } from '@spinajs/queue';
import { USER_COMMON_METADATA, USER_SECURITY_METADATA_KEYS, User, UserBase } from './models/User.js';
import { cfg, service } from '@spinajs/configuration';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserLogged, UserPasswordChangeRequest, UserPasswordChanged, UserRoleGranted, UserRoleRevoked, UserUnbanned } from './events/index.js';
import { Constructor, DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UserEvent } from './events/UserEvent.js';
import { AuthProvider, PasswordProvider, PasswordValidationProvider, SessionProvider } from './interfaces.js';
import { DateTime } from 'luxon';
import { InvalidArgument } from '@spinajs/exceptions';
import { EmailTemplateNotConfigured, InvalidCredentials, LoginAttemptsExceeded, MetadataNotFound, MetadataNotPopulated, TokenExpired, TokenInvalid, UserAlreadyExists, UserIsBanned, UserNotActive } from './exceptions.js';
import { AccessControl } from 'accesscontrol';
import { createHash, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { UserLoginFailed } from './events/UserLoginFailed.js';
import { UserMetadataChange } from './events/UserMetadataChange.js';
import { UserPasswordExpired } from './events/UserPasswordExpired.js';
import { userModel } from './model-token.js';

/**
 * ===============================================
 *  FUNDAMENTALS ( imperative helpers )
 * ===============================================
 */

/**
 * Resolves a user by identifier with metadata populated.
 * If a {@link User} instance is passed it is returned as-is; otherwise the user is
 * looked up by id, uuid, email, or login and its metadata relation is populated.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function getUser(identifier: number | string | User): Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof User) {
    return id;
  }

  return userModel().query().whereAnything(id).populate('Metadata').firstOrFail();
}

/**
 * Unsafe user retrieval. It does not check for rbac permission, so this
 * function can read ANY user in system. USE IT CAREFULLY
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function getUserUnsafe(identifier: number | string | User): Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof UserBase) {
    return id as User;
  }

  return UserBase.query().whereAnything(id).populate('Metadata').firstOrFail() as Promise<User>;
}

/**
 * Gets system user account
 *
 * @returns system user
 */
export async function getSystemUser(): Promise<User> {
  const systemRole = _check_arg(_trim(), _non_empty())(cfg<string>('rbac.systemRole'), 'rbac.systemRole');
  const roleColumn = _check_arg(_trim(), _non_empty())(cfg<string>('rbac.roleColumn'), 'rbac.roleColumn');

  // base User on purpose: system account must resolve inside scoped request contexts
  return User.query().where(roleColumn, systemRole).firstOrFail();
}

/**
 * Gets users by role.
 *
 * @param role user roles
 */
export async function getUsersByRole(role: string[]): Promise<User[]> {
  return userModel().select().withRole(role);
}

/**
 * Sets metadata key-value pairs on a user.
 * Accepts either an array of `{ key, value }` objects or a single metadata key string with a separate value.
 * Emits a {@link UserMetadataChange} event after the metadata is persisted.
 *
 * @param u - user to modify
 * @param meta - metadata key (string) or array of `{ key, value }` entries to set
 * @param value - value to assign when `meta` is a single key string (default: `null`)
 */
export async function setUserMeta(u: User, meta: string | { key: string; value: any }[], value: any = null): Promise<User> {
  const mArgs = _check_arg(_non_nil(new MetadataNotPopulated('User metadata not loaded', { user: u.Uuid })), _toArray())(meta, 'Metadata');

  mArgs.forEach((m: string | { key: string; value: any }) => {
    _.isString(m) ? (u.Metadata[m] = value) : (u.Metadata[m.key] = m.value);
  });

  await u.Metadata.update();

  // the event carries the resolved entries, not the raw input - a single
  // string key is normalised to a { key, value } pair
  await ev(new UserMetadataChange(u, mArgs.map((m: string | { key: string; value: any }) => (_.isString(m) ? { key: m, value } : m))));

  return u;
}

/**
 * Retrieves a single metadata value from a user by key.
 * Throws if the user's metadata has not been populated or the requested key does not exist.
 *
 * @param u - user to read from
 * @param key - metadata key to retrieve
 */
export async function getUserMeta(u: User, key: string): Promise<any> {
  _check_arg(_non_nil(new MetadataNotPopulated('User metadata not loaded', { user: u.Uuid, key })))(u.Metadata, 'Metadata');
  _check_arg(_non_nil(new MetadataNotFound('Metadata not found in user data', { user: u.Uuid, key })))(u.Metadata[key], `Metadata.${key}`);

  return u.Metadata[key];
}

interface IEmailTemplateCfg {
  enabled: boolean;
  template: string;
  subject: string;
}

/**
 * Sends a user notification email. Templates are defined in rbac configuration.
 *
 * The email send result is deliberately discarded - actions end with this step
 * and must resolve with the User, not with an EmailSend job.
 *
 * @param u - recipient
 * @param cfgTemplate - which `rbac.email.*` entry describes the message
 * @param model - extra template variables merged over the user's own fields.
 *   Given as a FUNCTION of the user so a caller can compute them from the row it
 *   has just written ( the password-reset token is the case that needs it ).
 *   Nothing here is persisted and nothing is logged: whatever it carries goes
 *   straight into the rendered message.
 */
export async function sendUserEmail(
  u: User,
  cfgTemplate: 'changePassword' | 'created' | 'confirm' | 'deactivated' | 'activated' | 'deleted' | 'unbanned' | 'banned' | 'passwordWillExpire' | 'passwordExpired',
  model?: (u: User) => Promise<{ [key: string]: unknown }> | { [key: string]: unknown },
): Promise<User> {
  const extra = model ? await model(u) : undefined;
  const connection = cfg<string>('rbac.email.connection', 'default');

  let template: IEmailTemplateCfg;
  try {
    template = cfg<IEmailTemplateCfg>(`rbac.email.${cfgTemplate}`);
  } catch (err) {
    throw new EmailTemplateNotConfigured(`Email template ${cfgTemplate} not configured. Check rbac.email in config`, undefined, err);
  }

  _check_arg(_is_string(_non_empty(), _max_length(128)))(template.template, 'email.template');
  _check_arg(_is_string(_non_empty(), _max_length(128)))(template.subject, 'email.subject');

  if (template.enabled) {
    await emailDeferred({
      to: [u.Email],
      connection,
      model: { ...u.toJSON(), ...(extra ?? {}) },
      tag: `rbac-user-${cfgTemplate}`,
      template: template.template,
      subject: template.subject,
    });
  }

  return u;
}

/**
 * Persists partial changes to a user record and emits a {@link UserChanged} event.
 *
 * @param u - user to update
 * @param data - optional partial user fields to merge into the existing record
 */
export async function updateUser(u: User, data?: Partial<User>): Promise<User> {
  await updateModel(u, data);
  await ev(new UserChanged(u));
  return u;
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

  const provider = await service('rbac.session', SessionProvider);
  await provider.deleteByUser(userId);
}

/**
 * ===============================================
 *  FP WRAPPERS ( kept for compatibility and for use in chains )
 * ===============================================
 */

/**
 * Thunk form of {@link getSystemUser}.
 */
export function _get_system_user() {
  return getSystemUser();
}

/**
 * Thunk form of {@link getUsersByRole}.
 */
export function _get_users_by_role(role: string[]) {
  return () => getUsersByRole(role);
}

/**
 * Gets rbac user model by uuid or id, WITHOUT metadata populated.
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
 * Thunk form of {@link getUser}.
 */
export function _user(identifier: number | string | User): () => Promise<User> {
  return () => getUser(identifier);
}

/**
 * Thunk form of {@link getUserUnsafe}.
 */
export function _user_unsafe(identifier: number | string | User): () => Promise<User> {
  return () => getUserUnsafe(identifier);
}

/**
 * Chain step form of {@link setUserMeta}.
 */
export function _set_user_meta(meta: string | { key: string; value: any }[], value: any = null) {
  return (u: User) => setUserMeta(u, meta, value);
}

/**
 * Chain step form of {@link getUserMeta}.
 */
export function _get_user_meta(key: string) {
  return (u: User) => getUserMeta(u, key);
}

/**
 * Chain step form of {@link sendUserEmail}.
 */
export function _user_email(cfgTemplate: Parameters<typeof sendUserEmail>[1], model?: Parameters<typeof sendUserEmail>[2]) {
  return (u: User) => sendUserEmail(u, cfgTemplate, model);
}

/**
 * Chain step: emits a user-related event and forwards the user.
 */
export function _user_ev(event: Constructor<UserEvent>, ...args: any[]) {
  return async (u: User) => {
    await ev(new event(u, ...args));
    return u;
  };
}

/**
 * Chain step form of {@link updateUser}.
 */
export function _user_update(data?: Partial<User>) {
  return (u: User) => updateUser(u, data);
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
  const u = await getUser(identifier);

  await updateUser(u, { IsActive: true });
  await ev(new UserActivated(u));
  await sendUserEmail(u, 'activated');

  return u;
}

/**
 * Deactivates a user account.
 * Sets `IsActive` to `false`, emits a {@link UserDeactivated} event, and sends the deactivation email.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function deactivate(identifier: number | string | User): Promise<User> {
  const u = await getUser(identifier);

  await updateUser(u, { IsActive: false });

  // Sessions go with the account: a deactivated user must stop acting NOW, not
  // whenever their session happens to expire.
  await revokeUserSessions(u);

  await ev(new UserDeactivated(u));
  await sendUserEmail(u, 'deactivated');

  return u;
}

/**
 * Middleware signature used by the `create` action's `beforeCreate` / `afterCreate` hooks.
 */
export type CreateMiddleware = (u: User) => Promise<User> | User;

/**
 * Reads a create-middleware list from configuration.
 * An unset or empty `beforeCreate` / `afterCreate` list is a valid
 * "no middleware" result ( `cfg` accepts empty arrays ).
 */
function middlewareList(path: string): CreateMiddleware[] {
  const mw = cfg<CreateMiddleware[]>(path, []);
  return Array.isArray(mw) ? mw : [];
}

/**
 * Runs the user through each middleware in turn, feeding each one the previous
 * result.
 */
async function runCreateMiddleware(u: User, path: string): Promise<User> {
  let current = u;
  for (const mw of middlewareList(path)) {
    current = await mw(current);
  }
  return current;
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
  if (cfg<boolean>('rbac.requireKnownRole', true) === false) {
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
  const configured = cfg<Array<{ Name: string }>>('rbac.roles', []);
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
 * The thrown {@link UserAlreadyExists} carries `fields`, naming WHICH of login / email
 * clashed, so an http caller can mark the offending input rather than reporting
 * that something, somewhere, is already in use.
 *
 * @param login - login to check, or undefined to skip the login check
 * @param email - email to check, or undefined to skip the email check
 * @param exceptUserId - id of the account being updated, which may keep its own values
 */
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
    throw new UserAlreadyExists(`${clashes.join(' and ')} already in use`, { fields: clashes });
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
  const sPassword = await service<PasswordProvider>('rbac.password', PasswordProvider);

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
    const validator = await service<PasswordValidationProvider>('rbac.password.validation', PasswordValidationProvider);

    if (!validator.check(password)) {
      throw new InvalidArgument('Password does not meet requirements', 'password');
    }
  }

  const hPassword = await sPassword.hash(password);
  const metadata = options?.metadata;

  // Ahead of everything else, and ahead of `beforeCreate` in particular: a
  // request that is about to be refused must not first run middleware that
  // writes to another system ( the legacy-user mirror is one ).
  assertNoProtectedMetadata(metadata);
  await assertUserUnique(login, email);

  let u = new User({
    Id: options?.id,
    Email: email,
    Login: login,
    Password: hPassword,
    Role: roleNames,
    RegisteredAt: DateTime.now(),
    CreatedAt: DateTime.now(),
    IsActive: false,
    Uuid: uuidv4(),
  });

  u = await runCreateMiddleware(u, 'rbac.actions.create.beforeCreate');

  await insertModel(u);

  if (metadata !== undefined) {
    await setUserMeta(
      u,
      Object.entries(metadata).map(([key, value]) => ({ key, value })),
    );
  }

  u = await runCreateMiddleware(u, 'rbac.actions.create.afterCreate');

  await ev(new UserCreated(u));
  await sendUserEmail(u, 'created');

  // Hand the account to its owner when nobody else can: the password above was
  // invented here and immediately hashed, so without this the account is
  // unreachable until an administrator remembers a second screen.
  //
  // AFTER the "created" email so the two arrive in the order they are meant to
  // be read, and BY UUID rather than by the instance in hand — the reset writes
  // three metadata entries, and `getUser()` re-reads with `Metadata` populated,
  // which an instance built by `new User(...)` never is. Handing it the
  // instance stored nothing, silently, and left the account with no token.
  //
  // Swallowed on purpose: the account EXISTS by now. Throwing would tell the
  // caller creation failed when it did not, inviting a retry that then fails on
  // the duplicate login. A link that could not be issued can be re-sent.
  if (generated) {
    try {
      await passwordChangeRequest(u.Uuid);
    } catch (err) {
      DI.resolve(Log, ['rbac']).error(err as Error, `Could not issue the initial password reset for ${u.Uuid}. The account exists but its owner has no way in yet.`);
    }
  }

  // if generated we want to know not hashed password
  return { User: u, Password: password };
}

/**
 * Permanently deletes a user from the database.
 * Emits a {@link UserDeleted} event and sends the "deleted" email.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function deleteUser(identifier: number | string | User): Promise<void> {
  const u = await getUser(identifier);

  await u.destroy();

  // Same reason a deactivation revokes: the account may no longer act. A live
  // session outlasting the deletion is worse here than there — the session
  // middleware resolves its user through `isActiveUser()`, which no longer
  // matches a soft-deleted row, so every request from that session dies in
  // the middleware instead of being cleanly logged out.
  await revokeUserSessions(u);

  await ev(new UserDeleted(u));
  await sendUserEmail(u, 'deleted');
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

  const u = await getUser(identifier);

  u.Role = _.uniq([...u.Role, role]);
  await updateUser(u);
  await ev(new UserRoleGranted(u, role));

  return u;
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

  const u = await getUser(identifier);

  u.Role = u.Role.filter((r) => r !== role);
  await updateUser(u);
  await ev(new UserRoleRevoked(u, role));

  return u;
}

/**
 * Bans user for specified time. If duration is not given user is banned for 24h
 *
 * @param identifier user identifier one of : id, uuid, email, login
 * @param reason reason for ban
 * @param duration duration in seconds
 */
export async function ban(identifier: number | string | User, reason?: string, duration?: number): Promise<User> {
  duration = _check_arg(_default(24 * 60 * 60), _is_number(_gt(0)))(duration, 'duration');
  reason = _check_arg(_default('NO_REASON'), _max_length(255))(reason, 'reason');

  const u = await getUser(identifier);

  // duration-aware: an EXPIRED ban must not block re-banning ( the raw flag
  // stays behind until an explicit unban clears it )
  if (u.IsBanned) {
    throw new UserIsBanned(`User is already banned`, { user: u.Uuid });
  }

  await setUserMeta(u, [
    { key: USER_COMMON_METADATA.USER_BAN_DURATION, value: duration },
    { key: USER_COMMON_METADATA.USER_BAN_REASON, value: reason },
    { key: USER_COMMON_METADATA.USER_BAN_IS_BANNED, value: true },
    { key: USER_COMMON_METADATA.USER_BAN_START_DATE, value: DateTime.now() },
  ]);

  // A ban that leaves the banned user's session alive bans nothing until that
  // session expires — `isActiveUser` does not filter on the ban flag, so the
  // session would keep resolving happily.
  await revokeUserSessions(u);

  await ev(new UserBanned(u));
  await sendUserEmail(u, 'banned');

  return u;
}

/**
 * Unban user
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function unban(identifier: number | string | User): Promise<User> {
  const u = await getUser(identifier);

  if (!u.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]) {
    throw new UserIsBanned(`User is already unbanned`, { user: u.Uuid });
  }

  // actually remove the ban metadata from the DB. Assigning a regex-like
  // string key never cleared anything; delete() removes each key from store.
  await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_IS_BANNED);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_START_DATE);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_DURATION);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_REASON);

  await ev(new UserUnbanned(u));
  await sendUserEmail(u, 'unbanned');

  return u;
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
function passwordResetUrl(email: string, token: string): string {
  const base = cfg<string>('rbac.password.resetUrl', '');

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
export async function passwordChangeRequest(identifier: number | string | User): Promise<User> {
  const pwdWaitTime = cfg<number>('rbac.password.passwordResetWaitTime');
  const token = uuidv4();

  const u = await getUser(identifier);

  await setUserMeta(u, [
    { key: USER_COMMON_METADATA.USER_PWD_RESET_START_DATE, value: DateTime.now() },
    { key: USER_COMMON_METADATA.USER_PWD_RESET_TOKEN, value: token },
    { key: USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME, value: pwdWaitTime },
  ]);

  await ev(new UserPasswordChangeRequest(u));

  await sendUserEmail(u, 'changePassword', (usr: User) => ({
    Token: token,
    ResetUrl: passwordResetUrl(usr.Email, token),
    // Minutes rather than the raw seconds: a template writes "the link is
    // valid for X minutes", and doing the arithmetic in a handlebars
    // expression is not something every template engine can do.
    ExpiresInMinutes: Math.round(pwdWaitTime / 60),
  }));

  return u;
}

/**
 * Confirms a password reset by validating the token and expiration, then changing the password.
 * Throws if the token has expired or does not match the stored value.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param newPassword - the new plain-text password to set
 * @param token - the reset token that was issued by {@link passwordChangeRequest}
 */
export async function confirmPasswordReset(identifier: number | string | User, newPassword: string, token: string): Promise<User> {
  const u = await getUser(identifier);

  // A reset must not resurrect an account that is banned, deactivated or
  // deleted — otherwise the reset flow is a way around every one of those
  // states. Same exception family the caller already collapses into one
  // opaque failure, so this does not become an account-state oracle.
  // duration-aware: a user whose ban has expired can log in again, so they
  // must be able to reset their password too
  if (u.IsBanned) {
    throw new UserIsBanned(`Password reset refused: user is banned`, { user: u.Uuid });
  }

  if (!u.IsActive || u.DeletedAt) {
    throw new UserNotActive(`Password reset refused: user is not active`, { user: u.Uuid });
  }

  const dueDate: DateTime = await getUserMeta(u, USER_COMMON_METADATA.USER_PWD_RESET_START_DATE);
  const waitTime: number = await getUserMeta(u, USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME);

  if (dueDate.plus({ seconds: waitTime }) < DateTime.now()) {
    throw new TokenExpired(`Password change token expired, token expiration date is: ${dueDate.toISO()}`, {
      dueDate,
      waitTime,
      time: DateTime.now(),
      user: u.Uuid,
    });
  }

  const resetToken = await getUserMeta(u, USER_COMMON_METADATA.USER_PWD_RESET_TOKEN);

  if (!secureCompare(String(resetToken), token)) {
    // the STORED token is a live bearer credential and the submitted one may
    // be a near miss of it - neither belongs in a payload that gets logged
    throw new TokenInvalid(`Password change token invalid, operation not permitted`, {
      user: u.Uuid,
    });
  }

  await changeUserPassword(u, newPassword);

  // Burn the token. Validating it and leaving it in place made it a
  // multi-use credential for the whole `passwordResetWaitTime` window:
  // anyone who saw the reset mail once could keep re-taking the account.
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_TOKEN);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_START_DATE);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET);

  return u;
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
function secureCompare(a: string, b: string): boolean {
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
 * Changes a user's password.
 * The new password is validated against the configured {@link PasswordValidationProvider},
 * hashed via the configured {@link PasswordProvider}, persisted, and a
 * {@link UserPasswordChanged} event is emitted.
 *
 * @param u - user to change the password for
 * @param password - new plain-text password
 */
export async function changeUserPassword(u: User, password: string): Promise<User> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  const pwd = await service('rbac.password', PasswordProvider);
  const validator = await service('rbac.password.validation', PasswordValidationProvider);

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
    throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
  }

  const hPassword = await pwd.hash(password);
  await updateModel(u, { Password: hPassword });

  await setUserMeta(u, [
    { key: USER_COMMON_METADATA.USER_PWD_RESET_LAST_ATTEMPT, value: DateTime.now().toISO() },

    // a successful password change clears the login throttle: the
    // credential the failures were counted against no longer exists
    { key: USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS, value: 0 },
    { key: USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL, value: null },
  ]);

  // Every session was authorized by the OLD password. Whoever holds one
  // — including whoever the user is changing the password because of —
  // loses it here. Callers that want the acting user to stay logged in
  // ( eg. PATCH /user/password ) mint a fresh session afterwards.
  await revokeUserSessions(u);

  await ev(new UserPasswordChanged(u));

  return u;
}

/**
 * Chain step form of {@link changeUserPassword}.
 *
 * @param password - new plain-text password
 */
export function changePassword(password: string): (u: User) => Promise<User> {
  return (u: User) => changeUserPassword(u, password);
}

/**
 * Expire password for user.
 *
 * The stored credential is replaced with a freshly generated random one, so the
 * expired password stops working even if the account is re-activated without a
 * reset. The account is deactivated, {@link UserPasswordExpired} is emitted and
 * the 'passwordExpired' mail is sent.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function expirePassword(identifier: number | string | User): Promise<void> {
  const u = await getUser(identifier);

  const sPassword = await service('rbac.password', PasswordProvider);
  const hPassword = await sPassword.hash(sPassword.generate());
  await updateModel(u, { Password: hPassword });

  await deactivate(u);
  await ev(new UserPasswordExpired(u));
  await sendUserEmail(u, 'passwordExpired');
}

/**
 * Sends the 'passwordWillExpire' warning mail. No account state changes -
 * this is the notification half of the expiry flow, meant to be called by an
 * application scheduler ahead of {@link expirePassword}.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param expiresAt - optional instant the password expires, passed to the template
 */
export async function notifyPasswordWillExpire(identifier: number | string | User, expiresAt?: DateTime): Promise<User> {
  const u = await getUser(identifier);

  await sendUserEmail(u, 'passwordWillExpire', () => ({ ExpiresAt: expiresAt?.toISO() ?? null }));

  return u;
}

/**
 * Checks if password matches the user's password stored in db.
 *
 * @param u - user to check against
 * @param password - plain-text password to verify
 */
export async function verifyPassword(u: User, password: string): Promise<boolean> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  const sPwd = await service('rbac.password', PasswordProvider);
  return sPwd.verify(u.Password, password);
}

/**
 * Chain step form of {@link verifyPassword}. The user is taken from the step
 * argument - a regression once read it from a never-passed second parameter.
 *
 * @param password - plain-text password to verify
 */
export function passwordMatch(password: string) {
  return (u: User): Promise<boolean> => verifyPassword(u, password);
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

  // A lookup failure ( unknown account ) is NOT counted as a failed login -
  // there is no account to count it against.
  const u = await loginLookup(identifier);

  try {
    // Refuse before the password is even checked, so a locked account
    // cannot be probed at all during the lockout window.
    assertNotLocked(u);

    const sAuth = await service('rbac.auth', AuthProvider);

    // the authenticated user is a FRESH row read by the auth provider ( with
    // metadata populated ) - every step below acts on it, not on the lookup
    const authenticated = await sAuth.authenticate(u.Email, password);

    await updateModel(authenticated, { LastLoginAt: DateTime.now() });
    await clearLoginThrottle(authenticated);
    await ev(new UserLogged(authenticated));

    return authenticated;
  } catch (err) {
    // count the failure and lock the account once the configured
    // threshold is reached, then notify and rethrow for the caller
    await registerFailedLogin(u, err);
    await ev(new UserLoginFailed(u, err));

    throw err;
  }
}

/**
 * Resolves the user a login attempt names, answering an authentication failure
 * rather than an orm one when no such account exists.
 *
 * {@link getUserUnsafe} ends in `firstOrFail()`, whose `OrmNotFoundException` is
 * neither a rbac exception nor `InvalidArgument`: the login controller cannot read it
 * as an authentication failure, so it rethrows and `@spinajs/orm-http` maps it to
 * a 404 while a wrong password answers 401. That difference is an
 * account-enumeration oracle — the status code alone tells a caller whether an
 * address is registered. Both cases throw {@link InvalidCredentials}, exactly as
 * {@link SimpleDbAuthProvider.authenticate} already does for the password it
 * cannot verify.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User}
 */
async function loginLookup(identifier: number | string | User): Promise<User> {
  const id = _check_arg(_trim(), _non_nil())(identifier, 'identifier');

  if (id instanceof UserBase) {
    return id as User;
  }

  return UserBase.query().whereAnything(id).populate('Metadata').firstOrThrow(new InvalidCredentials('no user with given email')) as Promise<User>;
}

/**
 * Throws when the account is inside a lockout window opened by
 * {@link registerFailedLogin}.
 *
 * @param u - user attempting to authenticate
 */
export function assertNotLocked(u: User): void {
  const raw = u?.Metadata?.[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL];

  if (!raw) {
    return;
  }

  const lockedUntil = raw instanceof DateTime ? raw : DateTime.fromISO(String(raw));

  if (lockedUntil.isValid && lockedUntil > DateTime.now()) {
    throw new LoginAttemptsExceeded(`Too many failed login attempts, account is temporarily locked until ${lockedUntil.toISO()}`, {
      user: u.Uuid,
      lockedUntil,
    });
  }
}

/**
 * Clears the failure counter and any expired lock after a successful login.
 */
export async function clearLoginThrottle(u: User): Promise<void> {
  const meta = u?.Metadata;

  if (!meta) {
    return;
  }

  const hasAttempts = Number(meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] ?? 0) > 0;
  const hasLock = Boolean(meta[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL]);

  if (!hasAttempts && !hasLock) {
    return;
  }

  await meta.delete(USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS);
  await meta.delete(USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL);
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
 * @param u - user whose failed attempt is recorded
 * @param err - the error that ended the login attempt
 */
export async function registerFailedLogin(u: User, err: unknown): Promise<void> {
  const meta = u?.Metadata;

  if (!meta) {
    return;
  }

  if (err instanceof LoginAttemptsExceeded) {
    return;
  }

  const blockAfter = cfg<number>('rbac.password.blockAfterAttempts', 5);
  const lockoutTime = cfg<number>('rbac.password.lockoutTime', 15 * 60);

  if (!blockAfter || blockAfter <= 0) {
    return;
  }

  const attempts = Number(meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] ?? 0) + 1;

  if (attempts >= blockAfter) {
    meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] = 0;
    meta[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL] = DateTime.now().plus({ seconds: lockoutTime }).toISO();
  } else {
    meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] = attempts;
  }

  await meta.update();
}
