import { insertModel, updateModel } from '@spinajs/orm';
import { _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _is_string, _default, _max_length, toArray } from '@spinajs/util';
import _ from 'lodash';
import { emailDeferred, IEmailAttachement } from '@spinajs/email';
import { ev } from '@spinajs/queue';
import { NO_PASSWORD, USER_COMMON_METADATA, User, UserBase, isReservedLogin, isReservedMetadataKey } from './models/User.js';
import { cfg, service } from '@spinajs/configuration';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserLogged, UserPasswordChangeRequest, UserPasswordChanged, UserUnbanned } from './events/index.js';
import { Constructor, DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UserEvent } from './events/UserEvent.js';
import { AuthProvider, PasswordProvider, PasswordValidationProvider, SessionProvider } from './interfaces.js';
import { DateTime } from 'luxon';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { EmailTemplateNotConfigured, InvalidCredentials, LoginAttemptsExceeded, MetadataNotFound, MetadataNotPopulated, TokenExpired, TokenInvalid, UserAlreadyExists, UserCreatedIncomplete, UserIsBanned, UserNotActive } from './exceptions.js';
import { createHash, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { UserLoginFailed } from './events/UserLoginFailed.js';
import { UserMetadataChange } from './events/UserMetadataChange.js';
import { UserPasswordExpired } from './events/UserPasswordExpired.js';
import { userModel } from './model-token.js';
import { UserMetadataBase } from './models/UserMetadata.js';
import { DEFAULT_ROLES_KEY, assignGlobalRoles, defaultRoles, globalRoleHolders, holdsGlobalRole, revokeGlobalRole, userRef } from './role-assignments.js';
import { PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, PrincipalRef } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authz';
import { SYSTEM } from '@spinajs/authz';
import { USERS_TABLE, usersDriver, usersMatchingLogin } from './identity/sql.js';

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
 * Users holding any of the roles as a live GLOBAL assignment (`AssignmentStore.holders`), soft
 * deleted ones excluded. Assignments of subject sets are not expanded.
 *
 * @param role role names
 */
export async function getUsersByRole(role: string[]): Promise<User[]> {
  const uuids = await globalRoleHolders(roleList(role));
  const users: User[] = [];

  // Bounded IN lists: SQLite allows 999 bound parameters per statement.
  for (let i = 0; i < uuids.length; i += 500) {
    users.push(...(await userModel().select().whereIn('Uuid', uuids.slice(i, i + 500))));
  }

  return users;
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
  const mArgs = _check_arg(_non_nil(new MetadataNotPopulated('User metadata not loaded', { user: u.Uuid })), toArray)(meta, 'Metadata');

  mArgs.forEach((m: string | { key: string; value: any }) => {
    _.isString(m) ? (u.Metadata[m] = value) : (u.Metadata[m.key] = m.value);
  });

  await u.Metadata.update();

  // the event carries the resolved entries, not the raw input - a single
  // string key is normalised to a { key, value } pair
  await ev(
    new UserMetadataChange(
      u,
      mArgs.map((m: string | { key: string; value: any }) => (_.isString(m) ? { key: m, value } : m)),
    ),
  );

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

  /**
   * Inline images ( `cid:logo` etc ) or file attachments a consuming
   * application's own template markup references. Nothing in this stack
   * attaches them automatically, so the producer must name them here.
   */
  attachments?: IEmailAttachement[];
}

/**
 * Sends a user notification email. Templates are defined in rbac configuration.
 *
 * The email send result is deliberately discarded - actions end with this step
 * and must resolve with the User, not with an EmailSend job.
 *
 * @param u - recipient
 * @param cfgTemplate - which `users.email.*` entry describes the message
 * @param model - extra template variables merged over the user's own fields.
 *   Given as a FUNCTION of the user so a caller can compute them from the row it
 *   has just written ( the password-reset token is the case that needs it ).
 *   Nothing here is persisted and nothing is logged: whatever it carries goes
 *   straight into the rendered message.
 */
export async function sendUserEmail(u: User, cfgTemplate: 'changePassword' | 'created' | 'confirm' | 'deactivated' | 'activated' | 'deleted' | 'unbanned' | 'banned' | 'passwordWillExpire' | 'passwordExpired', model?: (u: User) => Promise<{ [key: string]: unknown }> | { [key: string]: unknown }): Promise<User> {
  const extra = model ? await model(u) : undefined;
  const connection = cfg<string>('users.email.connection', 'default');

  let template: IEmailTemplateCfg;
  try {
    template = cfg<IEmailTemplateCfg>(`users.email.${cfgTemplate}`);
  } catch (err) {
    throw new EmailTemplateNotConfigured(`Email template ${cfgTemplate} not configured. Check users.email in config`, undefined, err);
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
      // omitted rather than sent as `[]` - `IEmail.attachements` (the spelling
      // @spinajs/email itself uses) means "carries attachments" to consumers
      ...(template.attachments?.length ? { attachements: template.attachments } : {}),
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

  const provider = await service('authn.session', SessionProvider);
  await provider.deleteByUser(userId);
}

/**
 * ===============================================
 *  FP WRAPPERS ( kept for compatibility and for use in chains )
 * ===============================================
 */

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

  // An account activated directly is no longer awaiting its invite - without this
  // the marker survives and the user's next ORDINARY reset takes the invite branch,
  // re-emitting UserActivated for an account that never stopped being active.
  await u.Metadata.delete(USER_COMMON_METADATA.USER_INVITE_PENDING);

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

  // An account being switched off has no pending invite by definition - otherwise
  // the mailed link still redeems and activates an account an administrator
  // deliberately turned off. Dropped before IsActive is written: the redeem
  // activates only while the marker exists, so it cannot undo this write.
  await u.Metadata.delete(USER_COMMON_METADATA.USER_INVITE_PENDING);

  // Written even when the loaded row already reads false (the ORM skips a clean field): a redeem may have
  // activated the row since it was loaded.
  await usersDriver().update().in(USERS_TABLE).update({ IsActive: false }).where('Uuid', u.Uuid);
  u.IsActive = false;
  await ev(new UserChanged(u));

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
 * The account {@link create} makes.
 */
export interface ICreateUserData {
  Email: string;
  Login: string;

  /**
   * Plain-text password, set through `PasswordService.set` after its policy check. Omit it and the
   * account gets no password: it is marked `user:invite:pending` and `PasswordService.invite` hands it
   * to its owner.
   */
  Password?: string;

  /** Explicit user id. Useful when migrating accounts from another system. */
  Id?: number;

  /** Key-value metadata attached to the new account; reserved keys and globs are refused. */
  Metadata?: { [key: string]: any };
}

/** What {@link create} answers. It never carries a password. */
export interface ICreateUserResult {
  User: User;
}

/**
 * Optional inputs of the deprecated positional form of {@link create}.
 *
 * @deprecated 3.0: the fields of {@link ICreateUserData}. R1 deletes it.
 */
export interface ICreateUserOptions {
  password?: string;
  id?: number;
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
 * Refuses metadata keys that decide account access: every reserved key
 * ({@link isReservedMetadataKey}) and globs.
 *
 * `user:pwd_reset:token` is a bearer credential redeemable at the PUBLIC reset
 * endpoint and `2fa:*` is the second factor itself — writing either through
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

    return isReservedMetadataKey(key);
  });

  if (offending.length > 0) {
    throw new InvalidArgument(`Protected metadata keys cannot be set directly: ${offending.join(', ')}`);
  }
}

/**
 * Refuses a login / email already taken by another account: equal to its Login or Email in any form the login lookup
 * (`UserIdentityStore.findByLogin`) folds alike, so no account can take a case or width variant of another's login.
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
  const taken = async (value: string) => (await usersMatchingLogin(value)).some((u) => u.Id !== exceptUserId);

  if (login) {
    assertLoginNotReserved(login);

    if (await taken(login)) {
      clashes.push('Login');
    }
  }

  if (email && (await taken(email))) {
    clashes.push('Email');
  }

  if (clashes.length > 0) {
    throw new UserAlreadyExists(`${clashes.join(' and ')} already in use`, { fields: clashes });
  }
}

/**
 * Refuses a login {@link isReservedLogin} reserves for the accounts the framework seeds: an `InvalidArgument`
 * on field `login`. {@link assertUserUnique} applies it, so a rename is refused too.
 */
export function assertLoginNotReserved(login: string): void {
  if (isReservedLogin(login)) {
    throw new InvalidArgument(`Login ${login} is reserved`, 'login');
  }
}

/**
 * Hard-deletes a row `create()` has just inserted, with its metadata. `destroy()` would only soft
 * delete it and keep its login and email taken. A failure here is logged, not thrown: the caller is
 * already reporting the error that made it discard the row.
 */
async function discardInsertedUser(u: User): Promise<void> {
  try {
    const driver = User.query().Driver;
    await driver.del().from(UserMetadataBase.getModelDescriptor().TableName).where('user_id', u.Id);
    await driver.del().from(User.getModelDescriptor().TableName).where('Id', u.Id);
  } catch (err) {
    DI.resolve(Log, ['rbac']).error(err as Error, `Could not remove the account ${u.Uuid} after its creation failed; delete it by hand.`);
  }
}

async function passwordService(): Promise<PasswordService> {
  if (!DI.RootContainer.hasRegistered(PasswordService)) {
    throw new InvalidOption('users: create() needs a PasswordService (register @spinajs/authn-local) to set or invite a password');
  }

  return (await DI.resolve(PasswordService)) as PasswordService;
}

/**
 * Creates a user account.
 *
 * Refuses, before anything is written: a missing `PasswordService`, a supplied password that fails its
 * policy (`PasswordService.check`), protected metadata, a taken login or email, and a role `AuthzAdmin`
 * would refuse (a dry run of the grants). Then it inserts the user, sets the password or marks the account
 * `user:invite:pending`, grants the roles at GLOBAL, writes the metadata, runs the `beforeCreate` /
 * `afterCreate` middleware and emits {@link UserCreated}. If the password or the grants fail after the
 * insert, the row is removed again so no half-made account keeps the login.
 *
 * A supplied password gets the plain 'created' mail; without one, `PasswordService.invite` sends the
 * invite (authn-local's mailer), and users sends nothing. users never generates, hashes or returns a password.
 *
 * @param data - the account; see {@link ICreateUserData}
 * @param roles - role names granted to `user:<Uuid>` at GLOBAL; omitted or empty: `authz.rbac.defaultRoles`
 * @param actor - who creates it, for the AuthzAdmin and authn audit; default SYSTEM. As SYSTEM the grants
 *   skip AuthzAdmin's guard (escalation), so a caller acting for someone passes that principal.
 */
export async function create(data: ICreateUserData, roles?: string[], actor?: Principal): Promise<ICreateUserResult>;
/**
 * @deprecated 3.0: create({ Email, Login, Password, Id, Metadata }, roles). The result has no password any more.
 */
export async function create(email: string, login: string, roles: string[], options?: ICreateUserOptions): Promise<ICreateUserResult>;
export async function create(dataOrEmail: ICreateUserData | string, a?: string | string[], b?: string[] | Principal, c?: ICreateUserOptions): Promise<ICreateUserResult> {
  if (typeof dataOrEmail === 'string') {
    return createUser({ Email: dataOrEmail, Login: a as string, Password: c?.password, Id: c?.id, Metadata: c?.metadata }, b as string[], SYSTEM);
  }

  return createUser(dataOrEmail, a as string[] | undefined, (b as Principal | undefined) ?? SYSTEM);
}

async function createUser(data: ICreateUserData, roles: string[] | undefined, actor: Principal): Promise<ICreateUserResult> {
  const email = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(data?.Email, 'email');
  const login = _check_arg(_trim(), _non_empty(), _max_length(32))(data?.Login, 'login');
  assertLoginNotReserved(login);

  const password = typeof data.Password === 'string' && data.Password !== '' ? data.Password : undefined;
  const metadata = data.Metadata;

  const asked = roleList(roles);
  const roleNames = asked.length > 0 ? asked : defaultRoles(cfg<unknown>(DEFAULT_ROLES_KEY, []));

  const passwords = await passwordService();
  if (password !== undefined && (await passwords.check(password)).length > 0) {
    throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
  }

  // Ahead of `beforeCreate` in particular: a request that is about to be refused must not first run
  // middleware that writes to another system ( the legacy-user mirror is one ).
  assertNoProtectedMetadata(metadata);
  await assertUserUnique(login, email);

  const uuid = uuidv4();
  await assignGlobalRoles(uuid, roleNames, { reason: 'users:create', field: 'roles', actor, dryRun: true });

  let u = new User({
    Id: data.Id,
    Email: email,
    Login: login,
    Password: NO_PASSWORD,
    RegisteredAt: DateTime.now(),
    CreatedAt: DateTime.now(),
    IsActive: false,
    Uuid: uuid,
  });

  u = await runCreateMiddleware(u, 'users.actions.create.beforeCreate');

  await insertModel(u);

  const ref = userRef(u.Uuid);
  const ctx: AuthnContext = { now: new Date(), purpose: 'request' };
  // authn audits the actor as given; a user principal would carry its whole record there.
  const by: PrincipalRef = { type: actor.type, id: actor.id };

  try {
    if (password !== undefined) {
      const set = await passwords.set(ref, password, ctx, { actor: by });
      if (set.status !== 'set') {
        throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
      }
    } else {
      // Before the invite: the marker is what lets the redeem activate this still-inactive account.
      u.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = true;
      await u.Metadata.update();
    }

    await assignGlobalRoles(u.Uuid, roleNames, { reason: 'users:create', field: 'roles', actor });
  } catch (err) {
    await discardInsertedUser(u);
    throw err;
  }

  // The account exists and keeps its roles from here on, so a failure is not a reason to remove it; the caller
  // learns which account it is and whether to send the invite again.
  let invited = false;
  try {
    if (metadata !== undefined) {
      await setUserMeta(
        u,
        Object.entries(metadata).map(([key, value]) => ({ key, value })),
      );
    }

    u = await runCreateMiddleware(u, 'users.actions.create.afterCreate');

    await ev(new UserCreated(u, roleNames));

    if (password === undefined) {
      await passwords.invite(ref, ctx, { actor: by });
      invited = true;
    } else {
      await sendUserEmail(u, 'created');
    }
  } catch (err) {
    const error = (err as Error)?.name ?? typeof err;
    const resendInvite = password === undefined && !invited;
    const invite = resendInvite ? '; its invite was not sent, send it again with PasswordService.invite' : '';
    throw new UserCreatedIncomplete(`Account ${uuid} was created, but a later step failed (${error})${invite}`, { user: uuid, resendInvite, error });
  }

  return { User: u };
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
 * Grants `role` to the user at GLOBAL: `AuthzAdmin` `assignment.grant` of `user:<Uuid>` by `actor`.
 * As SYSTEM, a role the user already holds at GLOBAL is left as it is, expiry and tags included; another
 * actor always goes through AuthzAdmin. An unknown or unassignable role is an `InvalidArgument` (field `role`).
 *
 * @deprecated 3.0: AuthzAdmin.assign(actor, { subject: { type: 'user', id: uuid }, role, scope: GLOBAL }). R1 deletes it.
 * As SYSTEM (the default) it skips AuthzAdmin's guard (escalation, last holder, self lockout), so a
 * caller that passes no actor must check first; pass the caller's principal to have the guard run.
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param role - role name to grant
 * @param actor - who grants it; default SYSTEM
 * @returns the user
 */
export async function grant(identifier: number | string | User, role: string, actor: Principal = SYSTEM): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  const u = await getUser(identifier);

  // AuthzAdmin's grant is an upsert: it would reset the expiry and tags of the held assignment. Only
  // SYSTEM skips it; for another actor the answer would tell an unchecked caller which roles a user holds.
  if (actor !== SYSTEM || !(await holdsGlobalRole(u.Uuid, role))) {
    await assignGlobalRoles(u.Uuid, [role], { reason: 'users:grant', field: 'role', actor });
  }

  return u;
}

/**
 * Revokes the user's GLOBAL assignment of `role`: `AuthzAdmin` `assignment.revokeWhere` by `actor`.
 *
 * @deprecated 3.0: AuthzAdmin.execute(actor, [{ kind: 'assignment.revokeWhere', scope: GLOBAL, subject, role }]) or AuthzAdmin.revoke(actor, id). R1 deletes it.
 * As SYSTEM (the default) it skips AuthzAdmin's guard (escalation, last holder, self lockout), so a
 * caller that passes no actor must check first; pass the caller's principal to have the guard run.
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param role - role name to revoke
 * @param actor - who revokes it; default SYSTEM
 * @returns the user
 */
export async function revoke(identifier: number | string | User, role: string, actor: Principal = SYSTEM): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  const u = await getUser(identifier);

  await revokeGlobalRole(u.Uuid, role, { reason: 'users:revoke', field: 'role', actor });

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
 * `authn.local.reset.url` is the application's own redemption page. The token
 * and the address are appended as query parameters because that page has to send
 * both back to `POST /auth/password/reset`, and it has no other way of knowing
 * them. Returns an empty string when no url is configured — the template then
 * renders whatever it does without one, rather than a link to nowhere.
 */
function passwordResetUrl(email: string, token: string): string {
  const base = cfg<string>('authn.local.reset.url', '');

  if (!base) {
    return '';
  }

  const url = new URL(base);
  url.searchParams.set('token', token);
  url.searchParams.set('email', email);

  return url.toString();
}

/**
 * Issues a password-reset token into the user's metadata and emits
 * {@link UserPasswordChangeRequest}. Sends nothing.
 *
 * Separate from {@link passwordChangeRequest} because `create()` delivers the very same
 * link inside the account-created mail: two mails carrying two tokens would leave
 * whichever the user opened second pointing at an already-overwritten token.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param waitTime - token lifetime in seconds; defaults to `authn.local.reset.ttlSeconds`
 */
export async function issuePasswordResetToken(identifier: number | string | User, waitTime?: number): Promise<{ user: User; token: string; waitTime: number }> {
  const ttl = waitTime ?? cfg<number>('authn.local.reset.ttlSeconds');
  const token = uuidv4();

  const u = await getUser(identifier);

  await setUserMeta(u, [
    { key: USER_COMMON_METADATA.USER_PWD_RESET_START_DATE, value: DateTime.now() },
    { key: USER_COMMON_METADATA.USER_PWD_RESET_TOKEN, value: token },
    { key: USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME, value: ttl },
  ]);

  await ev(new UserPasswordChangeRequest(u));

  return { user: u, token, waitTime: ttl };
}

/**
 * Initiates a password-change request for a user: issues the token and mails it.
 *
 * THE MAIL IS THE POINT. The token is issued into metadata and never returned over HTTP —
 * possession of the mailbox is what authorizes the reset — so an installation that does not
 * deliver it has a reset flow nobody can complete. `users.email.changePassword.enabled: false`
 * still turns it off for an application that really does deliver it some other way.
 *
 * The token reaches the template through the model and is NOT logged: it is a bearer
 * credential for `POST /auth/password/reset`.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param waitTime - token lifetime in seconds; defaults to `authn.local.reset.ttlSeconds`
 */
export async function passwordChangeRequest(identifier: number | string | User, waitTime?: number): Promise<User> {
  const { user, token, waitTime: ttl } = await issuePasswordResetToken(identifier, waitTime);

  await sendUserEmail(user, 'changePassword', (usr: User) => ({
    Token: token,
    ResetUrl: passwordResetUrl(usr.Email, token),
    // Minutes rather than the raw seconds: a template writes "the link is
    // valid for X minutes", and doing the arithmetic in a handlebars
    // expression is not something every template engine can do.
    ExpiresInMinutes: Math.round(ttl / 60),
  }));

  return user;
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

  // An account created by an administrator is inactive until its owner redeems the link
  // that was mailed to it, so the ONLY inactive user a reset may touch is one still
  // carrying that marker. A deactivated or deleted account carries none, and the
  // resurrection the guard exists to prevent stays prevented.
  // Strict, not truthy: the sole writer stores a real boolean `true`, and a value ever
  // stored as the STRING 'false' would otherwise silently reopen this guard.
  const invitePending = u.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] === true;

  if ((!u.IsActive && !invitePending) || u.DeletedAt) {
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

  // Redeeming the invite is the activation: the owner has now proved they hold the
  // mailbox and has chosen a password nobody else knows. No 'activated' mail — the
  // person doing this is looking at the page that did it.
  if (invitePending) {
    await updateUser(u, { IsActive: true });
    await ev(new UserActivated(u));
  }

  // Burn the token. Validating it and leaving it in place made it a
  // multi-use credential for the whole `passwordResetWaitTime` window:
  // anyone who saw the reset mail once could keep re-taking the account.
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_TOKEN);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_START_DATE);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_PWD_RESET);
  await u.Metadata.delete(USER_COMMON_METADATA.USER_INVITE_PENDING);

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

  const pwd = await service('authn.local.hasher', PasswordProvider);
  const validator = await service('authn.local.policy', PasswordValidationProvider);

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

  const sPassword = await service('authn.local.hasher', PasswordProvider);
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

  const sPwd = await service('authn.local.hasher', PasswordProvider);
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
