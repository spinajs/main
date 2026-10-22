import { insertModel, updateModel } from '@spinajs/orm';
import { _check_arg, _gt, _non_nil, _is_email, _non_empty, _trim, _is_number, _is_string, _default, _max_length, toArray } from '@spinajs/util';
import _ from 'lodash';
import { emailDeferred, IEmailAttachement } from '@spinajs/email';
import { ev } from '@spinajs/queue';
import { NO_PASSWORD, USER_COMMON_METADATA, User, UserBase, isReservedLogin, isReservedMetadataKey } from './models/User.js';
import { cfg } from '@spinajs/configuration';
import { UserActivated, UserBanned, UserChanged, UserCreated, UserDeactivated, UserDeleted, UserUnbanned } from './events/index.js';
import { Constructor, DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UserEvent } from './events/UserEvent.js';
import { DateTime } from 'luxon';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { EmailTemplateNotConfigured, MetadataNotFound, MetadataNotPopulated, UserAlreadyExists, UserCreatedIncomplete, UserIsBanned } from './exceptions.js';
import { v4 as uuidv4 } from 'uuid';
import { UserMetadataChange } from './events/UserMetadataChange.js';
import { userModel } from './model-token.js';
import { UserMetadataBase } from './models/UserMetadata.js';
import { DEFAULT_ROLES_KEY, assignGlobalRoles, globalRoleHolders, userRef } from './role-assignments.js';
import { PasswordService, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, PrincipalRef } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authz';
import { SYSTEM, currentPrincipal } from '@spinajs/authz';
import { USERS_TABLE, usersDriver, usersMatchingLogin } from './identity/sql.js';
import { hookCopy } from '@spinajs/authn/hooks';
import { ownValues, runUserAction, userView } from './hooks.js';
import type { UserDraft, UsersCreateData } from './hooks.js';

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

  return runUserAction(
    'users.metadata.set',
    () => ({ user: userView(u), meta: entries }),
    async (changed) => {
      const written = changed.meta ? hookedEntries(changed.meta, entries) : entries;
      return writeUserMeta(u, written);
    },
    { mutable: ['meta'], output: userView },
  );
}

/** The entries a `users.metadata.set` hook left, checked again; an entry it did not change is the caller's own. */
function hookedEntries(changed: unknown, own: { key: string; value: any }[]): { key: string; value: any }[] {
  if (!Array.isArray(changed) || !changed.every((m) => _.isPlainObject(m) && typeof (m as { key?: unknown }).key === 'string')) {
    throw new InvalidArgument('Metadata entries must be { key, value } objects', 'meta');
  }
  const entries = (changed as { key: string; value: unknown }[]).map((m) => own.find((o) => _.isEqual(m, hookCopy(o))) ?? { key: m.key, value: m.value });
  assertNoProtectedMetadata(Object.fromEntries(entries.map((m) => [m.key, m.value])));
  return entries;
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
  return runUserAction(
    'users.update',
    () => ({ user: userView(u), data: { ...(data ?? {}) } }),
    async (changed) => saveUser(u, changed.data ? await hookedUpdate(u, changed.data, data) : data),
    { mutable: ['data'], output: userView },
  );
}

/** Columns a `users.update` hook may not set: the row's identity and its password hash. */
const FIXED_COLUMNS = ['Id', 'Uuid', 'Password'] as const;

/** The patch a `users.update` hook left, checked again: a changed Login or Email must be free, and the fixed columns stay the caller's. */
async function hookedUpdate(u: User, changed: unknown, own: Partial<User> | undefined): Promise<Partial<User>> {
  if (!_.isPlainObject(changed)) {
    throw new InvalidArgument('The update must be an object', 'data');
  }
  const patch = new Map(Object.entries(ownValues(changed as Record<string, unknown>, own)));
  for (const column of FIXED_COLUMNS) {
    if (own && Object.hasOwn(own, column)) patch.set(column, Reflect.get(own, column));
    else patch.delete(column);
  }

  const renamed = (column: 'Login' | 'Email'): string | undefined => {
    const value: unknown = patch.get(column);
    if (value === undefined || value === Reflect.get(own ?? {}, column) || value === Reflect.get(u, column)) return undefined;
    if (typeof value !== 'string') throw new InvalidArgument(`${column} must be a string`, column);
    return value;
  };
  const login = renamed('Login');
  const email = renamed('Email');
  if (login !== undefined || email !== undefined) {
    await assertUserUnique(login, email, u.Id);
  }
  return Object.fromEntries(patch);
}

/** {@link updateUser} without its hooks: the lifecycle actions write their own state through it. */
async function saveUser(u: User, data?: Partial<User>): Promise<User> {
  await updateModel(u, data);
  await ev(new UserChanged(u));
  return u;
}

/**
 * Destroys every session belonging to a user, on every device.
 *
 * Called from the actions after which the account may no longer act: a ban, a
 * deactivation and a deletion. A password change or reset ends sessions in
 * authn-local (`LocalPasswordService`, `SessionIssuer.revokeAll`), not here.
 *
 * Errors are NOT swallowed: a session store that cannot be reached means the
 * revocation did not happen, and the caller must learn that rather than be told
 * the account is secure.
 *
 * Ends the authn sessions of `user:<Uuid>` through `SessionIssuer.revokeAll`, also
 * those where the user is the impersonator (N2, SR-06), when an issuer is
 * registered (none: no sessions exist).
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
 * Runs the `users.activate` hooks, then sets `IsActive` to `true` and emits a {@link UserActivated} event; the
 * `UserLifecycleMailHook` sends the activation mail. On an account that is already active it only drops a pending
 * invite marker: no hooks, no event, no mail.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function activate(identifier: number | string | User): Promise<User> {
  const u = await getUser(identifier);

  // An account activated directly is no longer awaiting its invite - without this
  // the marker survives and the user's next ORDINARY reset takes the invite branch,
  // re-emitting UserActivated for an account that never stopped being active.
  const dropInvite = () => u.Metadata.delete(USER_COMMON_METADATA.USER_INVITE_PENDING);
  if (u.IsActive) {
    await dropInvite();
    return u;
  }

  return runUserAction(
    'users.activate',
    () => ({ user: userView(u) }),
    async () => {
      await dropInvite();
      await saveUser(u, { IsActive: true });
      await ev(new UserActivated(u));
      return u;
    },
    { mutable: [], output: userView },
  );
}

/**
 * Deactivates a user account.
 * Runs the `users.deactivate` hooks, then sets `IsActive` to `false`, ends its sessions and API and agent tokens and
 * emits a {@link UserDeactivated} event; the `UserLifecycleMailHook` sends the deactivation mail. When a revocation throws, the deactivation is already stored: the caller finishes with
 * {@link revokeUserSessions} and {@link revokeUserTokens}.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function deactivate(identifier: number | string | User): Promise<User> {
  const u = await getUser(identifier);

  return runUserAction('users.deactivate', () => ({ user: userView(u) }), () => deactivateNow(u), { mutable: [], output: userView });
}

async function deactivateNow(u: User): Promise<User> {
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

  return u;
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
    DI.resolve(Log, ['rbac']).error({ error: err, userUuid: u.Uuid }, 'Could not remove the account ${userUuid} after its creation failed; delete it by hand.');
  }
}

async function passwordService(): Promise<PasswordService> {
  // authn-local, which users imports, registers LocalPasswordService; this only fires in a container that lost it.
  if (!DI.RootContainer.hasRegistered(PasswordService)) {
    throw new InvalidOption('users: create() needs a PasswordService (register @spinajs/authn-local) to set or invite a password');
  }

  return (await DI.resolve(PasswordService)) as PasswordService;
}

const checkEmail = (value: unknown): string => _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(value, 'email') as string;
const checkLogin = (value: unknown): string => _check_arg(_trim(), _non_empty(), _max_length(32))(value, 'login') as string;

/** The roles a create grants: those asked for, or `authz.rbac.defaultRoles` when none are. */
function rolesToGrant(asked: string[]): string[] {
  if (asked.length > 0) return asked;
  // Runtime Configuration.set is not schema-validated: a bare string must not be spread into one-letter roles.
  const configured = cfg<unknown>(DEFAULT_ROLES_KEY, []);
  return [...new Set(Array.isArray(configured) ? (configured as string[]) : [])];
}

/** What {@link create} inserts and grants once its checks passed. */
interface CreatePlan {
  readonly id?: number;
  readonly email: string;
  readonly login: string;
  readonly metadata?: { [key: string]: any };
  readonly roleNames: string[];
  /** Columns a `users.create` hook set on the unsaved user. */
  readonly columns: Record<string, unknown>;
}

/** Columns of the unsaved user that only `create()` sets, or that come through `data`. */
const DRAFT_OWN_COLUMNS = new Set(['Uuid', 'Password', 'Email', 'Login', 'Id']);

/** The unsaved user `create()` inserts; a hook's columns go first, so the account's Uuid and password marker stay `create()`'s. */
function draftOf(uuid: string, plan: CreatePlan, now: DateTime<true>): User {
  return new User({
    ...(plan.id !== undefined ? { Id: plan.id } : {}),
    RegisteredAt: now,
    CreatedAt: now,
    IsActive: false,
    ...plan.columns,
    Email: plan.email,
    Login: plan.login,
    Password: NO_PASSWORD,
    Uuid: uuid,
  });
}

/**
 * The plan after the `users.create` hooks, with the checks that guard each changed value run again: the email and login
 * checks, the password policy and uniqueness for a changed email or login, the protected metadata, the role dry run.
 * A column a hook set on `user` wins over the same field in `data`.
 */
async function hookedCreate(changed: Partial<{ data: UsersCreateData; roles: string[]; user: UserDraft }>, own: CreatePlan, view: UserDraft, uuid: string, actor: Principal, password: string | undefined, passwords: PasswordService): Promise<CreatePlan> {
  let { id, email, login, metadata, roleNames } = own;
  let columns: Record<string, unknown> = {};

  if (changed.data !== undefined) {
    if (!_.isPlainObject(changed.data)) throw new InvalidArgument('The account data must be an object', 'data');
    ({ Email: email, Login: login, Id: id } = changed.data);
    const changedMetadata: unknown = changed.data.Metadata;
    if (changedMetadata !== undefined && !_.isPlainObject(changedMetadata)) throw new InvalidArgument('Metadata must be an object', 'Metadata');
    metadata = changedMetadata === undefined ? undefined : ownValues(changedMetadata as Record<string, unknown>, own.metadata);
  }

  if (changed.user !== undefined) {
    if (!_.isPlainObject(changed.user)) throw new InvalidArgument('The user must be an object', 'user');
    const user = changed.user;
    if (user.Email !== view.Email) email = user.Email;
    if (user.Login !== view.Login) login = user.Login;
    if (user.Id !== view.Id) id = user.Id;
    const known = new Set(User.getModelDescriptor().Columns?.map((c) => c.Name) ?? []);
    columns = Object.fromEntries(
      Object.entries(user)
        .filter(([column, value]) => !DRAFT_OWN_COLUMNS.has(column) && known.has(column) && !_.isEqual(value, Reflect.get(view, column)))
        .map(([column, value]) => [column, value instanceof Date ? DateTime.fromJSDate(value) : value]),
    );
  }

  if (changed.data !== undefined || changed.user !== undefined) {
    email = checkEmail(email);
    login = checkLogin(login);
    assertLoginNotReserved(login);
    if (id !== undefined && id !== null && !(Number.isSafeInteger(id) && id > 0)) throw new InvalidArgument('Id must be a positive integer', 'id');

    if (email !== own.email || login !== own.login) {
      if (password !== undefined && (await passwords.check(password, { login, email })).length > 0) {
        throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
      }
      await assertUserUnique(login, email);
    }
    assertNoProtectedMetadata(metadata);
  }

  if (changed.roles !== undefined) {
    if (!Array.isArray(changed.roles)) throw new InvalidArgument('Roles must be a list', 'roles');
    roleNames = rolesToGrant(roleList(changed.roles));
    await assignGlobalRoles(uuid, roleNames, { reason: 'users:create', field: 'roles', actor, dryRun: true });
  }

  return { ...(id !== undefined && id !== null ? { id } : {}), email, login, ...(metadata !== undefined ? { metadata } : {}), roleNames, columns };
}

/**
 * Creates a user account.
 *
 * `PasswordService` is the last one registered: authn-local's `LocalPasswordService`, which importing users registers,
 * unless the application registers its own after importing users.
 *
 * Refuses, before anything is written and before the `users.create` hooks run: a supplied password that fails its policy
 * (`PasswordService.check`), protected metadata, a taken login or email, and a role `AuthzAdmin` would refuse (a dry run
 * of the grants). Then the `users.create` before hooks may change `user`, `data` and `roles`, or refuse (`ActionRefused`);
 * the checks guarding what they changed run again. Then it inserts the user, sets the password or marks the account
 * `user:invite:pending`, grants the roles at GLOBAL, writes the metadata and emits {@link UserCreated}. If the password
 * or the grants fail after the insert, the row is removed again so no half-made account keeps the login. The after hooks
 * see `output.User`; a failing one is logged.
 *
 * A supplied password gets the plain 'created' mail (`UserLifecycleMailHook`); without one, `PasswordService.invite`
 * sends the invite (authn-local's mailer), and users sends nothing. users never generates, hashes or returns a password.
 *
 * @param data - the account; see {@link ICreateUserData}
 * @param roles - role names granted to `user:<Uuid>` at GLOBAL; omitted or empty: `authz.rbac.defaultRoles`
 * @param actor - who creates it, for the AuthzAdmin and authn audit; default SYSTEM. As SYSTEM the grants
 *   skip AuthzAdmin's guard (escalation), so a caller acting for someone passes that principal.
 */
export async function create(data: ICreateUserData, roles?: string[], actor: Principal = SYSTEM): Promise<ICreateUserResult> {
  const email = checkEmail(data?.Email);
  const login = checkLogin(data?.Login);
  assertLoginNotReserved(login);

  const password = typeof data.Password === 'string' && data.Password !== '' ? data.Password : undefined;
  const metadata = data.Metadata;
  const roleNames = rolesToGrant(roleList(roles));

  const passwords = await passwordService();
  if (password !== undefined && (await passwords.check(password, { login, email })).length > 0) {
    throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
  }

  // Ahead of the users.create hooks in particular: a request that is about to be refused must not first run
  // a hook that writes to another system ( e.g. a user mirror ).
  assertNoProtectedMetadata(metadata);
  await assertUserUnique(login, email);

  const uuid = uuidv4();
  await assignGlobalRoles(uuid, roleNames, { reason: 'users:create', field: 'roles', actor, dryRun: true });

  const now = DateTime.now();
  const plan: CreatePlan = { ...(data.Id !== undefined ? { id: data.Id } : {}), email, login, ...(metadata !== undefined ? { metadata } : {}), roleNames, columns: {} };
  const view = () => userView(draftOf(uuid, plan, now)) as UserDraft;
  const hookData = (): UsersCreateData => ({ Email: email, Login: login, ...(data.Id !== undefined ? { Id: data.Id } : {}), ...(metadata !== undefined ? { Metadata: metadata } : {}) });

  return runUserAction(
    'users.create',
    () => ({ data: hookData(), roles: [...roleNames], user: view(), actor }),
    async (changed) => insertCreated(uuid, Object.keys(changed).length > 0 ? await hookedCreate(changed, plan, view(), uuid, actor, password, passwords) : plan, now, password, passwords, actor),
    { mutable: ['user', 'data', 'roles'], output: (r) => ({ User: userView(r.User), Invited: password === undefined }) },
  );
}

async function insertCreated(uuid: string, plan: CreatePlan, now: DateTime<true>, password: string | undefined, passwords: PasswordService, actor: Principal): Promise<ICreateUserResult> {
  const u = draftOf(uuid, plan, now);
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

    await assignGlobalRoles(u.Uuid, plan.roleNames, { reason: 'users:create', field: 'roles', actor });
  } catch (err) {
    await discardInsertedUser(u);
    throw err;
  }

  // The account exists and keeps its roles from here on, so a failure is not a reason to remove it; the caller
  // learns which account it is and whether to send the invite again.
  let invited = false;
  try {
    if (plan.metadata !== undefined) {
      await setUserMeta(
        u,
        Object.entries(plan.metadata).map(([key, value]) => ({ key, value })),
      );
    }

    await ev(new UserCreated(u, plan.roleNames));

    if (password === undefined) {
      await passwords.invite(ref, ctx, { actor: by });
      invited = true;
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
 * Emits a {@link UserDeleted} event; the `UserLifecycleMailHook` sends the "deleted" mail. When a revocation throws, the row is already
 * deleted: the caller finishes with {@link revokeUserSessions} and {@link revokeUserTokens}, by numeric id.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 */
export async function deleteUser(identifier: number | string | User): Promise<void> {
  const u = await getUser(identifier);

  await runUserAction(
    'users.delete',
    () => ({ user: userView(u) }),
    async () => {
      await u.destroy();

      // The account may no longer act: end its sessions and tokens now rather
      // than leave them to expire.
      await revokeUserSessions(u);
      await revokeUserTokens(u);

      await ev(new UserDeleted(u));
    },
    { mutable: [], output: () => undefined },
  );
}

const checkBanDuration = (value: unknown): number => _check_arg(_default(24 * 60 * 60), _is_number(_gt(0)))(value, 'duration') as number;
const checkBanReason = (value: unknown): string => _check_arg(_default('NO_REASON'), _is_string(_max_length(255)))(value, 'reason') as string;

/**
 * Bans user for specified time. If duration is not given user is banned for 24h. A `users.ban` hook may change the
 * reason and the duration, which are checked again. Ends its sessions and API and agent tokens. When a revocation throws, the ban is already stored (a second ban is refused): the caller finishes with
 * {@link revokeUserSessions} and {@link revokeUserTokens}.
 *
 * @param identifier user identifier one of : id, uuid, email, login
 * @param reason reason for ban
 * @param duration duration in seconds
 */
export async function ban(identifier: number | string | User, reason?: string, duration?: number): Promise<User> {
  const seconds = checkBanDuration(duration);
  const why = checkBanReason(reason);

  const u = await getUser(identifier);

  // duration-aware: an EXPIRED ban must not block re-banning ( the raw flag
  // stays behind until an explicit unban clears it )
  if (u.IsBanned) {
    throw new UserIsBanned(`User is already banned`, { user: u.Uuid });
  }

  return runUserAction(
    'users.ban',
    () => ({ user: userView(u), reason: why, duration: seconds }),
    async (changed) => {
      await writeUserMeta(u, [
        { key: USER_COMMON_METADATA.USER_BAN_DURATION, value: 'duration' in changed ? checkBanDuration(changed.duration) : seconds },
        { key: USER_COMMON_METADATA.USER_BAN_REASON, value: 'reason' in changed ? checkBanReason(changed.reason) : why },
        { key: USER_COMMON_METADATA.USER_BAN_IS_BANNED, value: true },
        { key: USER_COMMON_METADATA.USER_BAN_START_DATE, value: DateTime.now() },
      ]);

      // As for a deletion: end the sessions and tokens now, not at expiry.
      await revokeUserSessions(u);
      await revokeUserTokens(u);

      await ev(new UserBanned(u));
      return u;
    },
    { mutable: ['reason', 'duration'], output: userView },
  );
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

  return runUserAction(
    'users.unban',
    () => ({ user: userView(u) }),
    async () => {
      // actually remove the ban metadata from the DB. Assigning a regex-like
      // string key never cleared anything; delete() removes each key from store.
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_IS_BANNED);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_START_DATE);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_DURATION);
      await u.Metadata.delete(USER_COMMON_METADATA.USER_BAN_REASON);

      await ev(new UserUnbanned(u));
      return u;
    },
    { mutable: [], output: userView },
  );
}

/** The context users passes to authn for an action it runs itself (no request, no client ip). */
const actionContext = (): AuthnContext => ({ now: new Date(), purpose: 'request' });

/**
 * Makes the user's password unusable: `PasswordService.expire(user:<Uuid>, { cause: 'admin', actor })`, which stores
 * authn-local's `'!expired'` marker, ends every authn session and, under `authn.local.reset.revokeTokens`, every API
 * token. The `UserLifecycleMailHook` then sends the 'passwordExpired' mail. {@link UserPasswordExpired} comes
 * from authn's event through `QueueAuthnEventSink`.
 *
 * The account stays active: authn lets only an active (or invited) account redeem a reset, and the mail asks the owner
 * to set a new password.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param actor - who expires it, for authn's audit; default SYSTEM
 */
export async function expirePassword(identifier: number | string | User, actor: Principal = SYSTEM): Promise<void> {
  const u = await getUser(identifier);

  await runUserAction(
    'users.password.expire',
    () => ({ user: userView(u), actor }),
    async () => {
      await (await passwordService()).expire(userRef(u.Uuid), { cause: 'admin', actor: { type: actor.type, id: actor.id } }, actionContext());
    },
    { mutable: [], output: () => undefined },
  );
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
