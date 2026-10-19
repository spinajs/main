import { NotFound } from '@spinajs/http';
import type { BadRequestResponse, Request } from '@spinajs/http';
import type { ResourceRef, TokenCreateOptions, TokenRecord, TokenScope } from '@spinajs/authn/contracts';
import { isPlainObject, parseIsoInstant } from '@spinajs/util';

import { NO_STORE, badRequest, instant } from '../v3/responses.js';
import { bodyField, boundedString } from '../v3/routes.js';

// Body fields and answers of the 3.0 token routes. Every field is checked and capped before TokenService sees it. No
// answer but the create answer, and no error message, carries a plaintext.

/** authn-token's own limit on a token name. */
const NAME_CAP = 128;
const ROLE_CAP = 128;
const ROLES_MAX = 64;
const PROFILE_CAP = 128;
const SCOPE_STRING_CAP = 256;
/** authn-token's own limit on scope permissions and resources. */
const SCOPE_ENTRIES_MAX = 1000;
/** Longer than any rbac_access_tokens.Uuid. */
export const TOKEN_ID_CAP = 64;

const KINDS: readonly string[] = ['pat', 'service', 'agent'];
const SCOPE_KEYS: readonly string[] = ['permissions', 'resources', 'agent'];
const RESOURCE_KEYS: readonly string[] = ['type', 'id'];

const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every((k) => allowed.includes(k));

/** One answer for a foreign, an unknown and a malformed id, so the route tells nothing about other owners' tokens. */
export const tokenNotFound = (): NotFound => new NotFound({ error: 'token_not_found', message: 'No such token' }, { Headers: [NO_STORE] });

export const invalidExpiry = (): BadRequestResponse => badRequest('invalid_expiry', 'expiresAt must be an ISO 8601 instant after now and within the configured maximum lifetime');

export function expiryOf(value: unknown): Date | null {
  return parseIsoInstant(value) ?? null;
}

/** undefined: absent; null: malformed. */
function rolesOf(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > ROLES_MAX || !value.every((r) => boundedString(r, ROLE_CAP) !== null)) return null;
  return [...(value as string[])];
}

/** A copy that holds the contract's keys only; null: malformed. */
function scopeOf(value: unknown): TokenScope | null {
  if (!isPlainObject(value) || !onlyKeys(value, SCOPE_KEYS)) return null;
  const { permissions, resources, agent } = value;
  const out: { permissions?: string[]; resources?: ResourceRef[]; agent?: boolean } = {};
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || permissions.length > SCOPE_ENTRIES_MAX || !permissions.every((p) => boundedString(p, SCOPE_STRING_CAP) !== null)) return null;
    out.permissions = [...(permissions as string[])];
  }
  if (resources !== undefined) {
    if (!Array.isArray(resources) || resources.length > SCOPE_ENTRIES_MAX) return null;
    const refs: ResourceRef[] = [];
    for (const r of resources as unknown[]) {
      if (!isPlainObject(r) || !onlyKeys(r, RESOURCE_KEYS)) return null;
      const type = boundedString(r.type, SCOPE_STRING_CAP);
      const id = r.id === undefined ? undefined : boundedString(r.id, SCOPE_STRING_CAP);
      if (type === null || id === null) return null;
      refs.push(id === undefined ? { type } : { type, id });
    }
    out.resources = refs;
  }
  if (agent !== undefined) {
    if (typeof agent !== 'boolean') return null;
    out.agent = agent;
  }
  return out;
}

/**
 * The create options of a POST /user/tokens body, or its 400 answer. Fields, the 2.x names in brackets: `name` (`Name`),
 * `expiresAt` (`ExpiresAt`, mandatory), optional `roles` (`Roles`), `profile` (`Profile`), `kind` (`pat` by default,
 * `service` or `agent`) and `scope` (`{ permissions?, resources?, agent? }`). TokenService checks the rest: the expiry
 * against the caps, the roles against the owner's, the profile against TokenProfilePolicy, scope against kind.
 */
export function tokenRequestOf(req: Request): { opts: TokenCreateOptions } | { answer: BadRequestResponse } {
  const name = bodyField(req, 'name', 'Name');
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_CAP) return { answer: badRequest('invalid_name', `name must be a non-blank string of at most ${NAME_CAP} characters`) };
  const expiresAt = expiryOf(bodyField(req, 'expiresAt', 'ExpiresAt'));
  if (expiresAt === null) return { answer: invalidExpiry() };
  const kind = bodyField(req, 'kind') ?? 'pat';
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return { answer: badRequest('invalid_kind', `kind must be one of ${KINDS.join(', ')}`) };
  const roles = rolesOf(bodyField(req, 'roles', 'Roles'));
  if (roles === null) return { answer: badRequest('invalid_roles', `roles must be a list of at most ${ROLES_MAX} role names of at most ${ROLE_CAP} characters`) };
  const rawProfile = bodyField(req, 'profile', 'Profile');
  const profile = rawProfile === undefined ? undefined : boundedString(rawProfile, PROFILE_CAP);
  // An empty profile is refused, not read as none: that would mint an unpinned token where a pinned one was asked for.
  if (profile === null) return { answer: badRequest('invalid_profile', `profile must be a non-empty string of at most ${PROFILE_CAP} characters`) };
  const rawScope = bodyField(req, 'scope');
  const scope = rawScope === undefined ? undefined : scopeOf(rawScope);
  if (scope === null) return { answer: badRequest('invalid_scope', 'scope must be { permissions?, resources?, agent? } within the limits') };
  const opts = { name, expiresAt, kind, ...(roles !== undefined ? { roles } : {}), ...(profile !== undefined ? { profile } : {}), ...(scope !== undefined ? { scope } : {}) };
  return { opts: opts as TokenCreateOptions };
}

function scopeEntry(s: TokenScope): Record<string, unknown> {
  return {
    ...(s.permissions !== undefined ? { permissions: [...s.permissions] } : {}),
    ...(s.resources !== undefined ? { resources: s.resources.map((r) => (r.id === undefined ? { type: r.type } : { type: r.type, id: r.id })) } : {}),
    ...(s.agent !== undefined ? { agent: s.agent } : {}),
  };
}

/** The wire shape of one token: 2.x names, ISO instants, absent values null. Never the plaintext or its hash. */
export function tokenEntry(r: TokenRecord, now: Date): Record<string, unknown> {
  return {
    Uuid: r.id,
    Name: r.name,
    Kind: r.kind,
    Roles: [...(r.roles ?? [])],
    Profile: r.profile ?? null,
    Scope: r.scope ? scopeEntry(r.scope) : null,
    CreatedAt: instant(r.createdAt),
    ExpiresAt: instant(r.expiresAt),
    LastUsedAt: instant(r.lastUsedAt),
    LastUsedIp: r.lastUsedIp ?? null,
    Expired: r.expiresAt.getTime() <= now.getTime(),
  };
}
