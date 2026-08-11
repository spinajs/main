import _ from 'lodash';
import { DateTime } from 'luxon';
import { User } from '@spinajs/rbac';
import { _chain, _check_arg, _tap, _trim, _non_empty, _non_nil, _max_length } from '@spinajs/util';
import { _service } from '@spinajs/configuration';
import { _ev } from '@spinajs/queue';
import { ErrorCode } from '@spinajs/exceptions';
import { Constructor } from '@spinajs/di';

import { AccessToken } from './models/AccessToken.js';
import { AccessTokenGenerationProvider } from './interfaces.js';
import { AccessTokenCreated, AccessTokenDeleted, AccessTokenEvent, AccessTokenRoleGranted, AccessTokenRoleRevoked } from './events/index.js';

export enum E_CODES {
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
    return () => User.where('Uuid', user).populate('Metadata').firstOrFail();
  }

  if (_.isNumber(user)) {
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
 * Ensures every role in `roles` is currently held by `owner`.
 * A token must never carry a role its owner does not have.
 */
function _assert_roles_subset(owner: User, roles: string[]) {
  const missing = roles.filter((r) => !owner.Role.includes(r));

  if (missing.length !== 0) {
    throw new ErrorCode(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED, `Owner does not hold role(s): ${missing.join(', ')}`, { roles: missing });
  }
}

/**
 * Creates a new access token for a user.
 *
 * Roles must be a non-empty subset of the owner's current roles. `expiresAt`
 * null means the token never expires. The plaintext is returned once and
 * never persisted - only its hash is stored.
 *
 * @param user - owner: {@link User} instance, numeric id or uuid
 * @param name - human readable label
 * @param roles - roles carried by the token, subset of the owner's roles
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
 * Adds a role to a token. The role must be held by the token owner.
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
      _assert_roles_subset(owner, [role]);

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
        throw new ErrorCode(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED, 'Cannot revoke the last role from a token - delete the token instead', { token: t.Uuid });
      }

      t.Roles = remaining;
      await t.update();
    }),
    _token_ev(AccessTokenRoleRevoked, role),
  );
}
