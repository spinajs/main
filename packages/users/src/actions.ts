import { insertModel, updateModel } from '@spinajs/orm';
import { _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _is_string, _default, _max_length, toArray } from '@spinajs/util';
import _ from 'lodash';
import { emailDeferred, IEmailAttachement } from '@spinajs/email';
import { ev } from '@spinajs/queue';
import { NO_PASSWORD, USER_COMMON_METADATA, User, UserBase, isReservedLogin, isReservedMetadataKey } from './models/User.js';
import { cfg } from '@spinajs/configuration';
import { legacyService } from './legacy-services.js';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserLogged, UserPasswordChanged, UserUnbanned } from './events/index.js';
import { Constructor, DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UserEvent } from './events/UserEvent.js';
import { AuthProvider, LegacySessionProvider, PasswordProvider } from './interfaces.js';
import { DateTime } from 'luxon';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { EmailTemplateNotConfigured, InvalidCredentials, LoginAttemptsExceeded, MetadataNotFound, MetadataNotPopulated, PasswordChangeConflict, TokenInvalid, UserAlreadyExists, UserCreatedIncomplete, UserIsBanned } from './exceptions.js';
import { v4 as uuidv4 } from 'uuid';
import { UserLoginFailed } from './events/UserLoginFailed.js';
import { UserMetadataChange } from './events/UserMetadataChange.js';
import { userModel } from './model-token.js';
import { UserMetadataBase } from './models/UserMetadata.js';
import { DEFAULT_ROLES_KEY, assignGlobalRoles, globalRoleHolders, holdsGlobalRole, revokeGlobalRole, userRef } from './role-assignments.js';
import { PasswordService, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, PrincipalRef } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authz';
import { SYSTEM, currentPrincipal } from '@spinajs/authz';
import { USERS_TABLE, isNoPassword, recordPasswordSetAt, usersDriver, usersMatchingLogin } from './identity/sql.js';
import { UserPasswordStore } from './identity/password-store.js';
import { UserIdentityStore } from './identity/identity-store.js';

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
 * Refuses reserved keys and globs ({@link assertNoProtectedMetadata}, A12): account security state has its own
 * actions (ban, invite), and authentication state lives in authn, never in metadata.
 *
 * @param u - user to modify
 * @param meta - metadata key (string) or array of `{ key, value }` entries to set
 * @param value - value to assign when `meta` is a single key string (default: `null`)
 */
export async function setUserMeta(u: User, meta: string | { key: string; value: any }[], value: any = null): Promise<User> {
  const entries = metadataEntries(u, meta, value);
  assertNoProtectedMetadata(Object.fromEntries(entries.map((m) => [m.key, m.value])));

  return writeUserMeta(u, entries);
}

function metadataEntries(u: User, meta: string | { key: string; value: any }[], value: any): { key: string; value: any }[] {
  const mArgs = _check_arg(_non_nil(new MetadataNotPopulated('User metadata not loaded', { user: u.Uuid })), toArray)(meta, 'Metadata');
  return mArgs.map((m: string | { key: string; value: any }) => (_.isString(m) ? { key: m, value } : m));
}

/** users' own lifecycle writes (ban state), which may touch reserved keys; never exported. */
async function writeUserMeta(u: User, entries: { key: string; value: any }[]): Promise<User> {
  entries.forEach((m) => (u.Metadata[m.key] = m.value));

  await u.Metadata.update();
  await ev(new UserMetadataChange(u, entries));

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
 * @param model - extra template variables merged over the user's own fields,
 *   given as a function of the user. The mail is queued (`emailDeferred`), so the
 *   model must never carry a secret: reset and invite links are authn-local's
 *   `PasswordMailer`'s, which sends at once (SR-09).
 */
export async function sendUserEmail(u: User, cfgTemplate: 'created' | 'confirm' | 'deactivated' | 'activated' | 'deleted' | 'unbanned' | 'banned' | 'passwordWillExpire' | 'passwordExpired', model?: (u: User) => Promise<{ [key: string]: unknown }> | { [key: string]: unknown }): Promise<User> {
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
 * Ends the authn sessions of `user:<Uuid>` through `SessionIssuer.revokeAll`, also
 * those where the user is the impersonator (N2, SR-06), when an issuer is
 * registered (none: no 3.0 sessions exist). 3.0 session rows carry no numeric
 * `UserId`, so deleting a user needs this too. Then the deprecated 2.x store,
 * which legacy authn-http still fills.
 *
 * @param user - the user whose sessions are destroyed, or their numeric id
 */
export async function revokeUserSessions(user: User | number): Promise<void> {
  const u = _.isNumber(user) ? await User.query().withDeleted().where('Id', user).first() : user;

  if (!u?.Id) {
    return;
  }

  if (DI.RootContainer.hasRegistered(SessionIssuer)) {
    const issuer = (await DI.resolve(SessionIssuer)) as SessionIssuer;
    await issuer.revokeAll(userRef(u.Uuid), { includeImpersonations: true });
  }

  await revokeLegacySessions(u);
}

/**
 * Ends every API and agent token of `user:<Uuid>` through `TokenService.revokeAllFor` when one is registered (none: no
 * tokens exist). Validation already refuses a token of a banned, inactive or deleted owner; revoking keeps an unban,
 * a reactivation or a restored row from bringing the tokens back. Errors propagate, as in {@link revokeUserSessions}.
 *
 * The `token.revoke` audit names the ambient principal as the actor, SYSTEM included; an unattended or anonymous
 * caller is no one to name. The call runs as that caller, not as SYSTEM: authn-token's audit sinks run inside it, and
 * what they queue would be stamped with SYSTEM.
 *
 * @param user - the user whose tokens are revoked, or their numeric id (soft-deleted rows included)
 */
export async function revokeUserTokens(user: User | number): Promise<void> {
  const actor = actorOf(currentPrincipal());
  if (!DI.RootContainer.hasRegistered(TokenService)) {
    return;
  }

  const u = _.isNumber(user) ? await User.query().withDeleted().where('Id', user).first() : user;
  if (!u?.Uuid) {
    return;
  }

  const tokens = (await DI.resolve(TokenService)) as TokenService;
  await tokens.revokeAllFor(userRef(u.Uuid), actionContext(), actor ? { actor } : undefined);
}

function actorOf(p: Principal): PrincipalRef | undefined {
  return p.type === 'unattended' || p.type === 'anonymous' ? undefined : { type: p.type, id: p.id };
}

// R1 deletes it with the 2.x session store.
async function revokeLegacySessions(u: User): Promise<void> {
  const provider = await legacyService('authn.session', LegacySessionProvider);
  await provider.deleteByUser(u.Id);
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
 * Sets `IsActive` to `false`, ends its sessions and API and agent tokens, emits a {@link UserDeactivated} event, and
 * sends the deactivation email. When a revocation throws, the deactivation is already stored: the caller finishes with
 * {@link revokeUserSessions} and {@link revokeUserTokens}.
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
  await revokeUserTokens(u);

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
  // authn-local, which users imports, registers LocalPasswordService; this only fires in a container that lost it.
  if (!DI.RootContainer.hasRegistered(PasswordService)) {
    throw new InvalidOption('users: create() needs a PasswordService (register @spinajs/authn-local) to set or invite a password');
  }

  return (await DI.resolve(PasswordService)) as PasswordService;
}

/**
 * Creates a user account.
 *
 * `PasswordService` is the last one registered: authn-local's `LocalPasswordService`, which importing users registers,
 * unless the application registers its own after importing users.
 *
 * Refuses, before anything is written: a supplied password that fails its policy (`PasswordService.check`), protected
 * metadata, a taken login or email, and a role `AuthzAdmin` would refuse (a dry run of the grants). Then it inserts the user, sets the password or marks the account
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
  // Runtime Configuration.set is not schema-validated: a bare string must not be spread into one-letter roles.
  const configured = cfg<unknown>(DEFAULT_ROLES_KEY, []);
  const roleNames = asked.length > 0 ? asked : [...new Set(Array.isArray(configured) ? (configured as string[]) : [])];

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
 * Soft-deletes a user and ends its sessions ({@link revokeUserSessions}) and API and agent tokens.
 * Emits a {@link UserDeleted} event and sends the "deleted" email. When a revocation throws, the row is already
 * deleted: the caller finishes with {@link revokeUserSessions} and {@link revokeUserTokens}, by numeric id.
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
  await revokeUserTokens(u);

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
 * Bans user for specified time. If duration is not given user is banned for 24h. Ends its sessions and API and agent
 * tokens. When a revocation throws, the ban is already stored (a second ban is refused): the caller finishes with
 * {@link revokeUserSessions} and {@link revokeUserTokens}.
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

  await writeUserMeta(u, [
    { key: USER_COMMON_METADATA.USER_BAN_DURATION, value: duration },
    { key: USER_COMMON_METADATA.USER_BAN_REASON, value: reason },
    { key: USER_COMMON_METADATA.USER_BAN_IS_BANNED, value: true },
    { key: USER_COMMON_METADATA.USER_BAN_START_DATE, value: DateTime.now() },
  ]);

  // A ban that leaves the banned user's session alive bans nothing until that
  // session expires — `isActiveUser` does not filter on the ban flag, so the
  // session would keep resolving happily.
  await revokeUserSessions(u);
  await revokeUserTokens(u);

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

/** The context users passes to authn for an action it runs itself (no request, no client ip). */
const actionContext = (): AuthnContext => ({ now: new Date(), purpose: 'request' });

/** The email a 2.x identifier names; a string is taken as the login authn looks up. */
async function resetLogin(identifier: number | string | User): Promise<string> {
  if (typeof identifier === 'string') {
    return identifier;
  }

  return (await getUser(identifier)).Email;
}

/**
 * Asks authn for a reset mail: `PasswordService.requestReset(<email>)`. No token is issued, stored or returned here;
 * authn-local issues the secret and its `PasswordMailer` sends it at once (SR-09).
 *
 * @deprecated 3.0: PasswordService.requestReset(login, ctx). It returns no token any more (`token` is ''), and
 * `waitTime` is `authn.local.reset.ttlSeconds`. R1 deletes it after C2.
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param _waitTime - ignored; authn.local.reset.ttlSeconds rules
 */
export async function issuePasswordResetToken(identifier: number | string | User, _waitTime?: number): Promise<{ user: User; token: string; waitTime: number }> {
  const user = await passwordChangeRequest(identifier);
  return { user, token: '', waitTime: cfg<number>('authn.local.reset.ttlSeconds', 3600) };
}

/**
 * Asks authn for a reset mail for the user: `PasswordService.requestReset(<email>)`, which counts the request in the
 * reset throttle and mails the link through its `PasswordMailer` (authn-local). users sends no mail and stores nothing.
 *
 * @deprecated 3.0: PasswordService.requestReset(login, ctx). R1 deletes it after N8a and C2.
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param _waitTime - ignored; authn.local.reset.ttlSeconds rules
 * @throws LoginAttemptsExceeded when the reset throttle refuses the request
 */
export async function passwordChangeRequest(identifier: number | string | User, _waitTime?: number): Promise<User> {
  const user = await getUser(identifier);

  const result = await (await passwordService()).requestReset(user.Email, actionContext());
  if (result.status === 'throttled') {
    throw new LoginAttemptsExceeded('Password reset request throttled', { user: user.Uuid, retryAfterSeconds: result.retryAfterSeconds });
  }

  return user;
}

/**
 * Redeems a reset (or invite) secret through `PasswordService.redeemReset(<email>, token, newPassword)`, which checks
 * the account's status and the secret, sets the password and ends every session. authn's refusals become the 2.x
 * exceptions: `invalid` → {@link TokenInvalid}, `throttled` → {@link LoginAttemptsExceeded}, a policy violation →
 * `InvalidArgument` (field `password`). An invited account is activated by `UserAccountSink` on `invite.redeem`.
 *
 * @deprecated 3.0: PasswordService.redeemReset(login, secret, newPassword, ctx). R1 deletes it after N8a.
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param newPassword - the new plain-text password to set
 * @param token - the secret of the reset or invite mail
 */
export async function confirmPasswordReset(identifier: number | string | User, newPassword: string, token: string): Promise<User> {
  const login = await resetLogin(identifier);

  const result = await (await passwordService()).redeemReset(login, String(token ?? ''), String(newPassword ?? ''), actionContext());
  switch (result.status) {
    case 'reset': {
      // authn found the account with the folded lookup; an exact getUser(login) would miss a differently cased email.
      const ref = await new UserIdentityStore().findByLogin(login);
      return getUser(ref?.id ?? login);
    }
    case 'rejected':
      throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
    case 'throttled':
      throw new LoginAttemptsExceeded('Password reset throttled', { retryAfterSeconds: result.retryAfterSeconds });
    default:
      throw new TokenInvalid('Password change token invalid, operation not permitted');
  }
}

/**
 * Changes a user's password over the hash the caller loaded (`u.Password`, the one it verified): the 2.x provider
 * hashes it and `UserPasswordStore.set(id, hash, expected)` writes it only while that hash is still stored, so a reset,
 * an expiry or another change that landed meanwhile wins and this throws {@link PasswordChangeConflict}. Then every
 * session ends ({@link revokeUserSessions}) and {@link UserPasswordChanged} is emitted. No metadata is written (A12);
 * the 2.x login lockout of the account is cleared. The new password is checked by `PasswordService.check` and stored as
 * given, spaces included.
 *
 * @deprecated 3.0: PasswordService.change (the user's own change) or PasswordService.set (an admin). R1 deletes it
 * after C2.
 * @param u - user to change the password for, as loaded (with its Password)
 * @param password - new plain-text password
 */
export async function changeUserPassword(u: User, password: string): Promise<User> {
  // Not trimmed and checked by authn's policy: 3.0's login takes the password as typed (A04).
  password = _check_arg(_non_empty())(password, 'password');

  const pwd = await legacyService('authn.local.hasher', PasswordProvider);

  if ((await (await passwordService()).check(password)).length > 0) {
    // `InvalidArgument`, not a bare `Error`: @spinajs/http maps it to 400, with the field and code in the body.
    throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
  }

  const hash = await pwd.hash(password);
  // Without the loaded hash there is nothing to compare: `null` matches only an account with no password.
  const expected = typeof u.Password === 'string' && !isNoPassword(u.Password) ? u.Password : null;
  const ref = userRef(u.Uuid);
  if (!(await new UserPasswordStore().set(ref, hash, expected))) {
    throw new PasswordChangeConflict(`The password of user ${u.Uuid} changed meanwhile; load the user and try again`, { user: u.Uuid });
  }
  u.Password = hash;
  // This path publishes no authn event, so UserAccountSink does not see it.
  await recordPasswordSetAt(u.Uuid, new Date());

  await u.Metadata?.delete(USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS);
  await u.Metadata?.delete(USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL);

  // Every session was authorized by the OLD password. Callers that want the acting user to stay logged in
  // ( eg. PATCH /user/password ) mint a fresh session afterwards.
  await revokeUserSessions(u);

  await ev(new UserPasswordChanged(u));

  return u;
}

/**
 * Makes the user's password unusable: `PasswordService.expire(user:<Uuid>, { cause: 'admin', actor })`, which stores
 * authn-local's `'!expired'` marker, ends every authn session and, under `authn.local.reset.revokeTokens`, every API
 * token. users then ends the 2.x sessions too and sends the 'passwordExpired' mail. {@link UserPasswordExpired} comes
 * from authn's event through `QueueAuthnEventSink`.
 *
 * Unlike 2.x the account stays active: authn lets only an active (or invited) account redeem a reset, and the mail asks
 * the owner to set a new password.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param actor - who expires it, for authn's audit; default SYSTEM
 */
export async function expirePassword(identifier: number | string | User, actor: Principal = SYSTEM): Promise<void> {
  const u = await getUser(identifier);

  await (await passwordService()).expire(userRef(u.Uuid), { cause: 'admin', actor: { type: actor.type, id: actor.id } }, actionContext());
  await revokeLegacySessions(u);

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
 * @deprecated 3.0: PasswordService.change verifies the old password itself (inline fresh auth). R1 deletes it after C2.
 * @param u - user to check against
 * @param password - plain-text password to verify
 */
export async function verifyPassword(u: User, password: string): Promise<boolean> {
  password = _check_arg(_trim(), _non_empty())(password, 'password');

  const sPwd = await legacyService('authn.local.hasher', PasswordProvider);
  return sPwd.verify(u.Password, password);
}

/**
 * Authenticates a user with the given password.
 * Delegates to the configured {@link AuthProvider}, updates `LastLoginAt`, and emits a
 * {@link UserLogged} event on success. On failure a {@link UserLoginFailed} event is emitted
 * and the original error is re-thrown. Failures count in the 2.x metadata lockout.
 *
 * @deprecated 3.0: AuthnService.authenticate({ kind: 'password', login, password }, ctx). R1 deletes it after N8a.
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

    const sAuth = await legacyService('rbac.auth', AuthProvider);

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
 * @deprecated 3.0: authn's throttle (authn.throttle.*), which backs off and never locks. R1 deletes it after N8a, N5 and C2.
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
 *
 * @deprecated 3.0: authn's throttle (authn.throttle.*). R1 deletes it after N5.
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
 * seconds. The counter lives in metadata, which 3.0 forbids (A12); only the
 * deprecated 2.x login paths call it.
 *
 * @deprecated 3.0: authn's throttle (authn.throttle.*), which backs off and never locks. R1 deletes it after N8a, N5 and C2.
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
