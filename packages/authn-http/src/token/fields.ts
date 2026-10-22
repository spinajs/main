import { NotFound } from '@spinajs/http';
import type { BadRequestResponse } from '@spinajs/http';
import type { ResourceRef, TokenCreateOptions, TokenRecord, TokenScope, TokenUpdate } from '@spinajs/authn/contracts';
import { parseIsoInstant } from '@spinajs/util';

import type { AuthnTokenCreateBody, AuthnTokenUpdateBody } from '../dto/tokens.js';
import { NO_STORE, badRequest, instant } from '../v3/responses.js';

// Answers of the 3.0 token routes; the DTOs of dto/tokens.ts check and cap every field before TokenService sees it. No
// answer but the create answer, and no error message, carries a plaintext.

/** One answer for a foreign, an unknown and a malformed id, so the route tells nothing about other owners' tokens. */
export const tokenNotFound = (): NotFound => new NotFound({ error: 'token_not_found', message: 'No such token' }, { Headers: [NO_STORE] });

export const invalidExpiry = (): BadRequestResponse => badRequest('invalid_expiry', 'expiresAt must be an ISO 8601 instant after now and within the configured maximum lifetime');
export const invalidTokenName = (): BadRequestResponse => badRequest('invalid_name', 'name must be a non-blank string of at most 128 characters');
export const invalidKind = (): BadRequestResponse => badRequest('invalid_kind', 'kind must be one of pat, service, agent');
export const invalidRoles = (): BadRequestResponse => badRequest('invalid_roles', 'roles must be a list of at most 64 role names of at most 128 characters');
export const invalidProfile = (): BadRequestResponse => badRequest('invalid_profile', 'profile must be a non-empty string of at most 128 characters');
export const invalidTokenScope = (): BadRequestResponse => badRequest('invalid_scope', 'scope must be { permissions?, resources?, agent? } within the limits');
export const invalidGrace = (): BadRequestResponse => badRequest('invalid_grace', 'graceSeconds must be a whole number of seconds from 0 to 604800');
export const invalidUpdateRoles = (): BadRequestResponse => badRequest('invalid_roles', 'roles must be a list of 1 to 64 role names of at most 128 characters');

export function expiryOf(value: unknown): Date | null {
  return parseIsoInstant(value) ?? null;
}

/** A copy of the scope with the contract's keys only. */
function scopeOf(s: NonNullable<AuthnTokenCreateBody['scope']>): TokenScope {
  const resources = s.resources?.map((r): ResourceRef => (r.id === undefined ? { type: r.type } : { type: r.type, id: r.id }));
  return { ...(s.permissions !== undefined ? { permissions: [...s.permissions] } : {}), ...(resources !== undefined ? { resources } : {}), ...(s.agent !== undefined ? { agent: s.agent } : {}) };
}

/**
 * The create options of a POST /user/tokens body, or its 400 answer for an `expiresAt` no ISO 8601 instant. TokenService
 * checks the rest: the expiry against the caps, the roles against the owner's, the profile against TokenProfilePolicy,
 * scope against kind.
 */
export function tokenRequestOf(body: AuthnTokenCreateBody): { opts: TokenCreateOptions } | { answer: BadRequestResponse } {
  const expiresAt = expiryOf(body.expiresAt);
  if (expiresAt === null) return { answer: invalidExpiry() };
  const { name, roles, profile, scope } = body;
  const opts = { name, expiresAt, kind: body.kind ?? 'pat', ...(roles !== undefined ? { roles: [...roles] } : {}), ...(profile !== undefined ? { profile } : {}), ...(scope !== undefined ? { scope: scopeOf(scope) } : {}) };
  return { opts: opts as TokenCreateOptions };
}

/** The change of a PATCH /user/tokens/:uuid body (none for an absent body), or its 400 answer. TokenService checks that it only narrows. */
export function tokenUpdateOf(body: AuthnTokenUpdateBody | null): { change: TokenUpdate } | { answer: BadRequestResponse } {
  const change: { name?: string; roles?: string[]; expiresAt?: Date } = {};
  if (body?.name !== undefined) change.name = body.name;
  if (body?.roles !== undefined) change.roles = [...body.roles];
  if (body?.expiresAt !== undefined) {
    const expiresAt = expiryOf(body.expiresAt);
    if (expiresAt === null) return { answer: invalidExpiry() };
    change.expiresAt = expiresAt;
  }
  return { change };
}

function scopeEntry(s: TokenScope): Record<string, unknown> {
  return {
    ...(s.permissions !== undefined ? { permissions: [...s.permissions] } : {}),
    ...(s.resources !== undefined ? { resources: s.resources.map((r) => (r.id === undefined ? { type: r.type } : { type: r.type, id: r.id })) } : {}),
    ...(s.agent !== undefined ? { agent: s.agent } : {}),
  };
}

/** The wire shape of one token: ISO instants, absent values null. Never the plaintext or its hash. */
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
