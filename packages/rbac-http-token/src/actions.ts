import _ from 'lodash';
import { DateTime } from 'luxon';
import { AccessControl } from 'accesscontrol';
import { User } from '@spinajs/rbac';
import { _chain, _check_arg, _tap, _trim, _non_empty, _non_nil, _max_length } from '@spinajs/util';
import { _service } from '@spinajs/configuration';
import { _ev } from '@spinajs/queue';
import { ErrorCode } from '@spinajs/exceptions';
import { Constructor, DI } from '@spinajs/di';

import { AccessToken } from './models/AccessToken.js';
import { AccessTokenGenerationProvider, AccessTokenRolePolicy } from './interfaces.js';
import { AccessTokenCreated, AccessTokenDeleted, AccessTokenEvent, AccessTokenRoleGranted, AccessTokenRoleRevoked } from './events/index.js';

/**
 * Failure codes carried by every {@link ErrorCode} this module throws.
 *
 * Named `E_TOKEN_CODES` rather than the shorter `E_CODES` on purpose:
 * `@spinajs/rbac` exports an enum called `E_CODES` too, and both are re-exported
 * from their package index. A downstream barrel that does
 * `export * from '@spinajs/rbac'; export * from '@spinajs/rbac-http-token';`
 * would collide on the NAME while the members underneath carry different
 * numeric values - the kind of clash that resolves silently in a barrel and
 * makes an `err.code === E_CODES.X` comparison answer the wrong question.
 */
export enum E_TOKEN_CODES {
  E_TOKEN_NOT_FOUND,
  E_TOKEN_EXPIRED,
  E_TOKEN_OWNER_INVALID,
  E_TOKEN_ROLE_NOT_ALLOWED,
}

/**
 * Resolves an AccessToken from an instance or its uuid.
 */
export function _token(token: AccessToken | string): () => Promise<AccessToken> {
  if (_.isString(token)) {
    return () => AccessToken.where('Uuid', token).firstOrFail();
  }

  return () => Promise.resolve(token);
}

/**
 * Resolves the owning user by instance, numeric id or uuid, with metadata
 * populated ( needed for IsBanned checks downstream ).
 */
export function _owner(user: User | number | string): () => Promise<User> {
  if (_.isString(user)) {
    // base User on purpose: token-auth infrastructure resolves the token OWNER before any request scope exists; must not be row-scoped by an application model override.
    return () => User.where('Uuid', user).populate('Metadata').firstOrFail();
  }

  if (_.isNumber(user)) {
    // base User on purpose: token-auth infrastructure resolves the token OWNER before any request scope exists; must not be row-scoped by an application model override.
    return () => User.where('Id', user).populate('Metadata').firstOrFail();
  }

  return () => Promise.resolve(user);
}

/**
 * Emits a token-related event through the queue service and forwards the token.
 *
 * @param event - constructor of the {@link AccessTokenEvent} subclass to emit
 * @param args - additional arguments forwarded to the event constructor
 */
function _token_ev(event: Constructor<AccessTokenEvent>, ...args: any[]) {
  return async (t: AccessToken) => {
    await _ev(new event(t, ...args))();
    return t;
  };
}

/**
 * Roles the configured {@link AccessTokenRolePolicy} lets `owner` put on a
 * token. Resolved per call rather than cached, so a policy that answers from
 * live state ( the owner's current roles, the application's grants ) is not
 * frozen at boot.
 *
 * Filters the policy's answer down to role names `accesscontrol` actually
 * knows about ( i.e. present in `ac.getGrants()` ). A policy is arbitrary
 * application code and may return a typo'd or stale role name; without this
 * filter such a name would be offered by `GET user/tokens/roles`, accepted by
 * `createToken`/`grantTokenRole` onto a token, and then make every request
 * that token authenticates 500 - `checkRoutePermission` calls
 * `ac.can(roles)[permission](resource)`, and `accesscontrol` throws
 * `AccessControlError` for a role absent from its grants map. A role that
 * grants nothing must never be offered or authorised in the first place.
 */
export async function _allowed_roles(owner: User): Promise<string[]> {
  const policy = await _service<AccessTokenRolePolicy>('rbac.token.rolePolicy', AccessTokenRolePolicy)();
  const allowed = await policy.allowedRoles(owner);

  const ac = DI.get<AccessControl>('AccessControl')!;
  const grants = ac.getGrants();
  return allowed.filter((r) => Boolean(grants[r]));
}

/**
 * Ensures every role in `roles` is one the configured policy allows for
 * `owner`. Deliberately not "one the owner literally holds" - a policy may
 * permit roles beyond the owner's own `Role` list, or withhold ones on it;
 * that flexibility is the entire point of the policy seam.
 */
async function _assert_roles_subset(owner: User, roles: string[]) {
  const allowed = await _allowed_roles(owner);
  const missing = roles.filter((r) => !allowed.includes(r));

  if (missing.length !== 0) {
    throw new ErrorCode(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED, `Owner may not put role(s) on a token: ${missing.join(', ')}`, { roles: missing });
  }
}

/**
 * Creates a new access token for a user.
 *
 * Roles must be a non-empty subset of the roles the configured
 * {@link AccessTokenRolePolicy} allows the owner to carry ( see
 * `_allowed_roles` above - not necessarily the owner's literal `Role` list ).
 * `expiresAt` null means the token never expires. The plaintext is returned
 * once and never persisted - only its hash is stored.
 *
 * @param user - owner: {@link User} instance, numeric id or uuid
 * @param name - human readable label
 * @param roles - roles carried by the token, subset of what the configured
 *                {@link AccessTokenRolePolicy} allows the owner
 * @param expiresAt - absolute expiration, or null for a token that never expires
 */
export async function createToken(user: User | number | string, name: string, roles: string[], expiresAt: DateTime | null): Promise<{ Token: AccessToken; Plaintext: string }> {
  name = _check_arg(_trim(), _non_empty(), _max_length(128))(name, 'name');
  roles = _check_arg(_non_nil(), _non_empty())(roles, 'roles');

  const generator = await _service<AccessTokenGenerationProvider>('rbac.token.generation', AccessTokenGenerationProvider)();
  const generated = await generator.generate();

  return _chain(
    _owner(user),
    _tap(async (u: User) => _assert_roles_subset(u, roles)),
    async (u: User) => {
      const token = new AccessToken({
        Name: name,
        Token: generated.Hash,
        Roles: _.uniq(roles),
        // `ExpiresAt` is optional rather than nullable ( see the model ), so a
        // "never expires" token leaves the property unset instead of holding null.
        ExpiresAt: expiresAt ?? undefined,
        user_id: u.Id,
      });
      await token.insert();
      return token;
    },
    _token_ev(AccessTokenCreated),
    (t: AccessToken) => ({ Token: t, Plaintext: generated.Plaintext }),
  );
}

/**
 * Permanently deletes ( revokes ) a token.
 *
 * @param token - {@link AccessToken} instance or its uuid
 */
export async function deleteToken(token: AccessToken | string): Promise<void> {
  return _chain(
    _token(token),
    _tap((t: AccessToken) => t.destroy()),
    _token_ev(AccessTokenDeleted),
    () => undefined,
  );
}

/**
 * Adds a role to a token. The role must be allowed for the token owner by the
 * configured {@link AccessTokenRolePolicy}.
 *
 * @param token - {@link AccessToken} instance or its uuid
 * @param role - role name to grant
 */
export async function grantTokenRole(token: AccessToken | string, role: string): Promise<AccessToken> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _token(token),
    _tap(async (t: AccessToken) => {
      const owner = await _owner(t.user_id)();
      await _assert_roles_subset(owner, [role]);

      t.Roles = _.uniq([...t.Roles, role]);
      await t.update();
    }),
    _token_ev(AccessTokenRoleGranted, role),
  );
}

/**
 * Removes a role from a token.
 *
 * Not symmetric with {@link grantTokenRole}: revoking only ever narrows what a
 * token may do, so it needs no owner check.
 *
 * A token must always keep at least one role - revoking the last one is
 * refused, and full revocation means deleting the token. Beyond being
 * meaningless ( a role-less token authorises nothing ), an empty list is
 * actively corrupting: `@Set()` columns round-trip through `SqlSetConverter`,
 * which stores `[]` as `''` and reads `''` back as `['']`. That phantom empty
 * role then survives every later grant, permanently.
 *
 * @param token - {@link AccessToken} instance or its uuid
 * @param role - role name to revoke
 * @throws ErrorCode E_TOKEN_ROLE_NOT_ALLOWED when `role` is the token's last role
 */
export async function revokeTokenRole(token: AccessToken | string, role: string): Promise<AccessToken> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _token(token),
    _tap(async (t: AccessToken) => {
      const remaining = t.Roles.filter((r) => r !== role);

      // checked BEFORE mutating, so a refused revoke leaves the instance and
      // the row exactly as they were
      if (remaining.length === 0) {
        throw new ErrorCode(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED, 'Cannot revoke the last role from a token - delete the token instead', { token: t.Uuid });
      }

      t.Roles = remaining;
      await t.update();
    }),
    _token_ev(AccessTokenRoleRevoked, role),
  );
}

export interface ITokenValidationResult {
  User: User;
  Token: AccessToken;

  /**
   * Token roles the configured {@link AccessTokenRolePolicy} still allows for
   * the owner. Permission checks run with these.
   */
  EffectiveRoles: string[];
}

/**
 * Validates a presented plaintext token.
 *
 * Checks, in order: token exists ( by hash ), token not expired, owner active /
 * not soft-deleted / not banned, effective role intersection non-empty.
 * Throws ErrorCode with {@link E_TOKEN_CODES} on every failure path.
 *
 * The owner checks are spelled out instead of reusing the `isActiveUser` query
 * scope on purpose - a single "no such active user" result cannot say WHY, and
 * callers need to tell an expired token from a banned account.
 *
 * @param plaintext - token exactly as presented by the client
 */
export async function validateToken(plaintext: string): Promise<ITokenValidationResult> {
  // Degenerate input is a failed authentication like any other, so it has to
  // leave through the same door. `_check_arg(_trim(), _non_empty())` would
  // throw a raw InvalidArgument here - and a bare TypeError for nil, since
  // `_non_empty` dereferences `.length` - breaking the "always an ErrorCode"
  // contract this function is called under. Reported as E_TOKEN_NOT_FOUND with
  // the unknown-token message on purpose: a caller must not learn WHY.
  if (!_.isString(plaintext) || plaintext.trim().length === 0) {
    throw new ErrorCode(E_TOKEN_CODES.E_TOKEN_NOT_FOUND, 'Access token not found');
  }

  plaintext = plaintext.trim();

  const generator = await _service<AccessTokenGenerationProvider>('rbac.token.generation', AccessTokenGenerationProvider)();
  const hash = generator.hash(plaintext);

  const token = await AccessToken.where('Token', hash).first();
  if (!token) {
    throw new ErrorCode(E_TOKEN_CODES.E_TOKEN_NOT_FOUND, 'Access token not found');
  }

  if (token.IsExpired) {
    throw new ErrorCode(E_TOKEN_CODES.E_TOKEN_EXPIRED, 'Access token expired', { token: token.Uuid });
  }

  // Metadata carries the ban flag, so it must be populated - without it
  // `IsBanned` silently answers false and every banned owner authenticates.
  // base User on purpose: token-auth infrastructure resolves the token OWNER before any request scope exists; must not be row-scoped by an application model override.
  const owner = await User.where('Id', token.user_id).populate('Metadata').first();

  // `DeletedAt` is defence in depth: the orm's soft-delete scope already appends
  // `DeletedAt IS NULL` to User selects, so a deleted owner arrives as undefined.
  if (!owner || !owner.IsActive || owner.DeletedAt || owner.IsBanned) {
    throw new ErrorCode(E_TOKEN_CODES.E_TOKEN_OWNER_INVALID, 'Access token owner is not allowed to authenticate', { token: token.Uuid });
  }

  // roles are re-checked against the policy on every request rather than
  // trusted from the row: a role the owner loses - or one an application's
  // policy stops allowing - must take effect immediately, without having to
  // hunt down every token that still carries it
  const allowed = await _allowed_roles(owner);
  const effective = token.Roles.filter((r) => allowed.includes(r));
  if (effective.length === 0) {
    throw new ErrorCode(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED, 'Access token has no effective roles', { token: token.Uuid });
  }

  return { User: owner, Token: token, EffectiveRoles: effective };
}

/**
 * Deletes every token whose expiration has passed. Returns the deleted count.
 *
 * Intended for cyclic execution from a worker ( see `rbac:token-delete-expired` ).
 * Expired tokens are already refused by {@link validateToken}, so this is
 * housekeeping, not enforcement.
 */
export async function deleteExpiredTokens(): Promise<number> {
  // `whereNotNull` is not redundant next to `<=`: a null expiry means "never
  // expires", and null comparisons must not sweep those rows away.
  const expired = await AccessToken.where('ExpiresAt', '<=', DateTime.now()).whereNotNull('ExpiresAt');

  for (const t of expired) {
    await t.destroy();
  }

  return expired.length;
}

/**
 * Updates `LastUsedAt`, throttled: writes only when the stamp is absent or
 * older than `intervalSeconds`.
 *
 * Every authenticated request would otherwise write to the token row; the stamp
 * only needs to be accurate enough to spot unused tokens. Callers may
 * fire-and-forget.
 *
 * @param token - token to stamp
 * @param intervalSeconds - minimum time between two writes
 */
export async function touchToken(token: AccessToken, intervalSeconds: number): Promise<void> {
  const now = DateTime.now();

  if (token.LastUsedAt && token.LastUsedAt > now.minus({ seconds: intervalSeconds })) {
    return;
  }

  token.LastUsedAt = now;
  await token.update();
}
