import { DI, Inject, Injectable } from '@spinajs/di';
import { Config, service } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { AuthnEventSink, IdentityStore, RoleSource, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnFailure, Ceiling, IdentityRef, Principal, PrincipalRef, ResourceRef, TokenCreateOptions, TokenCreateResult, TokenKind, TokenRecord, TokenScope, TokenValidation } from '@spinajs/authn/contracts';
import { DateTime } from 'luxon';

import { AccessTokenGenerationProvider } from '../generation.js';
import { checkTokenFormat } from '../generator.js';
import { AccessToken, TOKEN_KINDS } from '../models/AccessToken.js';
import { TokenOwnerResolver } from './owner-resolver.js';
import { TokenProfilePolicy } from './profile-policy.js';

const MAX_NAME_LENGTH = 128;
/** Width of the comma-joined `Roles` column. */
const MAX_ROLES_LENGTH = 512;
const MAX_SCOPE_ENTRIES = 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

type Refusal = Extract<TokenCreateResult, { ok: false }>;
type Failure = Extract<TokenValidation, { ok: false }>;

const INVALID_SCOPE: Refusal = Object.freeze({ ok: false, code: 'invalid_scope' });
const INVALID_EXPIRY: Refusal = Object.freeze({ ok: false, code: 'invalid_expiry' });
const fail = (reason: AuthnFailure): Failure => ({ ok: false, reason });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The time value of a real Date, read without calling anything an override could replace; NaN otherwise. */
function instant(v: unknown): number {
  try {
    return Date.prototype.getTime.call(v);
  } catch {
    return Number.NaN;
  }
}

function toDate(v: unknown): Date | null {
  const d = DateTime.isDateTime(v) ? v.toJSDate() : v instanceof Date ? v : null;
  return d !== null && !Number.isNaN(d.getTime()) ? d : null;
}

/** undefined: absent; null: malformed. */
function parseRoles(roles: unknown): string[] | undefined | null {
  if (roles === undefined) {
    return undefined;
  }
  // Roles is a comma-joined column: a comma would smuggle in a second role.
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => isNonEmptyString(r) && !r.includes(','))) {
    return null;
  }
  const unique = [...new Set(roles as string[])];
  // Postgres and strict mysql would throw on overflow; non-strict mysql would cut the last role to another name.
  return unique.join(',').length <= MAX_ROLES_LENGTH ? unique : null;
}

/** Keeps only the known keys; undefined: no limits; null: malformed. */
function parseScope(scope: unknown, agent: boolean): TokenScope | undefined | null {
  if (scope === undefined) {
    return undefined;
  }
  if (!isRecord(scope)) {
    return null;
  }

  const out: { permissions?: string[]; resources?: ResourceRef[]; agent?: boolean } = {};

  if (scope.permissions !== undefined) {
    if (!Array.isArray(scope.permissions) || scope.permissions.length > MAX_SCOPE_ENTRIES || !scope.permissions.every(isNonEmptyString)) {
      return null;
    }
    out.permissions = [...scope.permissions];
  }

  if (scope.resources !== undefined) {
    if (!Array.isArray(scope.resources) || scope.resources.length > MAX_SCOPE_ENTRIES) {
      return null;
    }
    const resources: ResourceRef[] = [];
    for (const r of scope.resources as unknown[]) {
      if (!isRecord(r) || !isNonEmptyString(r.type) || (r.id !== undefined && typeof r.id !== 'string')) {
        return null;
      }
      resources.push(r.id === undefined ? { type: r.type } : { type: r.type, id: r.id });
    }
    out.resources = resources;
  }

  if (agent) {
    out.agent = true;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `TokenService` over `rbac_access_tokens`. Owners map to `user_id` through {@link TokenOwnerResolver};
 * owner status comes from {@link IdentityStore} on every validate.
 */
@Injectable(TokenService)
@Inject(TokenOwnerResolver, TokenProfilePolicy, IdentityStore)
export class DbTokenService extends TokenService {
  @Config('authn.token.maxTtlDays', { defaultValue: 90 })
  protected MaxTtlDays: number;

  @Config('authn.token.agentMaxTtlMinutes', { defaultValue: 1440 })
  protected AgentMaxTtlMinutes: number;

  @Config('authn.token.prefix', { defaultValue: 'spt_' })
  protected Prefix: string;

  @Config('authn.token.length', { defaultValue: 32 })
  protected Length: number;

  @Logger('authn-token')
  protected Log: Log;

  constructor(protected readonly owners: TokenOwnerResolver, protected readonly profiles: TokenProfilePolicy, protected readonly identities: IdentityStore) {
    super();
    // With nothing registered, DI injects the bare abstract class; fail at boot, not on the first valid token.
    if (typeof identities?.status !== 'function') {
      throw new Error('DbTokenService needs an IdentityStore; register one (e.g. @spinajs/users) before resolving TokenService');
    }
    if (typeof owners?.rowIdOf !== 'function' || typeof owners.refOf !== 'function') {
      throw new Error('DbTokenService needs a TokenOwnerResolver');
    }
    if (typeof profiles?.allowedProfiles !== 'function') {
      throw new Error('DbTokenService needs a TokenProfilePolicy');
    }
    // TokenService is not an AsyncService, so DI never calls resolve() itself.
    this.resolve();
  }

  /** Fails boot on a weak token format (A14); the generator checks again when minting. */
  public resolve(): void {
    checkTokenFormat(this.Prefix, this.Length);
  }

  public async create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult> {
    const now = this.nowOf(ctx);

    // Callers can bypass the types, so every field is checked as unknown.
    const raw: Record<string, unknown> = isRecord(opts) ? opts : {};
    const kind = raw.kind;
    if (typeof kind !== 'string' || !TOKEN_KINDS.includes(kind)) {
      return INVALID_SCOPE;
    }

    const agent = kind === 'agent';
    if (agent) {
      if (!isRecord(raw.scope) || raw.scope.agent !== true || raw.roles !== undefined || raw.profile !== undefined) {
        return INVALID_SCOPE;
      }
    } else if (isRecord(raw.scope) && raw.scope.agent === true) {
      return INVALID_SCOPE;
    }

    const roles = parseRoles(raw.roles);
    const scope = parseScope(raw.scope, agent);
    if (roles === null || scope === null) {
      return INVALID_SCOPE;
    }

    let profile: string | undefined;
    if (raw.profile !== undefined) {
      if (!isNonEmptyString(raw.profile) || !(await this.profiles.allowedProfiles(owner)).includes(raw.profile)) {
        return INVALID_SCOPE;
      }
      profile = raw.profile;
    }

    const expiresAt = instant(raw.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return INVALID_EXPIRY;
    }
    const cap = agent ? now + this.positive(this.AgentMaxTtlMinutes, 'agentMaxTtlMinutes') * MINUTE_MS : now + this.positive(this.MaxTtlDays, 'maxTtlDays') * DAY_MS;
    if (expiresAt <= now || expiresAt > cap) {
      return INVALID_EXPIRY;
    }

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new InvalidArgument(`token name must be 1 to ${MAX_NAME_LENGTH} characters`);
    }

    const rowId = await this.owners.rowIdOf(owner);
    if (rowId === null) {
      throw new Error(`Token owner ${String(owner?.type)}:${String(owner?.id)} is unknown to ${this.owners.constructor.name}`);
    }

    if (roles !== undefined && !(await this.ownerHolds(owner, roles))) {
      return INVALID_SCOPE;
    }

    const generator = await service<AccessTokenGenerationProvider>('authn.token.generation', AccessTokenGenerationProvider);
    const generated = await generator.generate();
    this.checkGenerated(generated?.Plaintext);

    const token = new AccessToken({
      Name: name,
      Token: generated.Hash,
      Roles: roles ?? [],
      Kind: kind as TokenKind,
      ExpiresAt: DateTime.fromMillis(expiresAt) as DateTime<true>,
      CreatedAt: DateTime.fromMillis(now) as DateTime<true>,
      user_id: rowId,
      ...(profile !== undefined ? { Profile: profile } : {}),
      ...(scope !== undefined ? { Scope: scope } : {}),
    });
    await token.insert();

    const record = this.recordOf(token, owner);
    await this.publish(ctx, now, 'token.create', owner, { token: record.id, kind: record.kind });

    return { ok: true, plaintext: generated.Plaintext, record };
  }

  public async list(owner: IdentityRef): Promise<readonly TokenRecord[]> {
    const rowId = await this.owners.rowIdOf(owner);
    if (rowId === null) {
      return [];
    }

    const rows = await AccessToken.where('user_id', rowId).whereNull('RevokedAt');
    return rows.map((t) => this.recordOf(t, owner));
  }

  public async revoke(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    const now = this.nowOf(ctx);
    if (!isNonEmptyString(id)) {
      return false;
    }
    const rowId = await this.owners.rowIdOf(owner);
    if (rowId === null) {
      return false;
    }

    const token = await AccessToken.where('Uuid', id).where('user_id', rowId).whereNull('RevokedAt').first();
    if (!token) {
      return false;
    }

    // Conditional on RevokedAt, so of two concurrent revokes only one answers true.
    const result = await AccessToken.update({ RevokedAt: DateTime.fromMillis(now) as DateTime<true> })
      .where('Id', token.Id)
      .whereNull('RevokedAt');
    if (this.affected(result) === 0) {
      return false;
    }

    await this.publish(ctx, now, 'token.revoke', owner, { token: token.Uuid, kind: token.Kind }, opts?.actor);
    return true;
  }

  public async revokeAllFor(owner: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<number> {
    const now = this.nowOf(ctx);
    const rowId = await this.owners.rowIdOf(owner);
    if (rowId === null) {
      return 0;
    }

    // Agent tokens acting for the owner carry the owner's user_id, so they are included.
    const result = await AccessToken.update({ RevokedAt: DateTime.fromMillis(now) as DateTime<true> })
      .where('user_id', rowId)
      .whereNull('RevokedAt');
    const count = this.affected(result);

    await this.publish(ctx, now, 'token.revoke', owner, { count }, opts?.actor);
    return count;
  }

  public async validate(raw: string, ctx: AuthnContext): Promise<TokenValidation> {
    // Without a valid now no token could ever count as expired.
    const now = instant(ctx?.now);
    if (!Number.isFinite(now) || !isNonEmptyString(raw)) {
      return fail('invalid_credentials');
    }

    const generator = await service<AccessTokenGenerationProvider>('authn.token.generation', AccessTokenGenerationProvider);
    const token = await AccessToken.where('Token', generator.hash(raw)).first();
    if (!token) {
      return fail('invalid_credentials');
    }
    if (token.RevokedAt) {
      return fail('revoked');
    }

    // A null expiry is a 2.x row the back-fill has not reached: expired, never eternal (SR-08).
    const expiresAt = toDate(token.ExpiresAt);
    if (expiresAt === null || expiresAt.getTime() <= now) {
      return fail('expired');
    }
    if (!TOKEN_KINDS.includes(token.Kind)) {
      return fail('invalid_credentials');
    }

    const owner = await this.owners.refOf(token.user_id);
    if (owner === null) {
      return fail('invalid_credentials');
    }
    const status = await this.identities.status(owner);
    if (!(status.exists && status.active && !status.banned && !status.deleted)) {
      return fail('invalid_credentials');
    }
    if (token.Profile && !(await this.profiles.allowedProfiles(owner)).includes(token.Profile)) {
      return fail('invalid_credentials');
    }

    const record = this.recordOf(token, owner);
    const limits: Pick<Ceiling, 'permissions' | 'resources'> = {
      ...(record.scope?.permissions !== undefined ? { permissions: record.scope.permissions } : {}),
      ...(record.scope?.resources !== undefined ? { resources: record.scope.resources } : {}),
    };

    if (record.kind === 'agent') {
      return {
        ok: true,
        identity: { type: 'agent', id: record.id },
        method: 'token',
        ceiling: { ...limits, reason: 'out_of_scope' },
        delegation: { onBehalfOf: owner, mode: 'inherit' },
        token: record,
      };
    }

    const ceiling: Ceiling = { ...(record.roles !== undefined ? { roles: record.roles } : {}), ...limits };
    return {
      ok: true,
      identity: owner,
      method: 'token',
      ...(Object.keys(ceiling).length > 0 ? { ceiling } : {}),
      ...(record.profile !== undefined ? { profile: record.profile } : {}),
      token: record,
    };
  }

  protected recordOf(t: AccessToken, owner: IdentityRef): TokenRecord {
    // The Set converter reads an empty column back as [''].
    const roles = (t.Roles ?? []).filter(isNonEmptyString);
    const createdAt = toDate(t.CreatedAt);
    if (createdAt === null) {
      throw new Error(`Access token ${t.Uuid} has an unreadable CreatedAt`);
    }
    const lastUsedAt = toDate(t.LastUsedAt);

    return {
      id: t.Uuid,
      owner: { type: owner.type, id: owner.id },
      name: t.Name,
      kind: t.Kind,
      ...(roles.length > 0 ? { roles } : {}),
      ...(t.Profile ? { profile: t.Profile } : {}),
      ...(t.Scope ? { scope: t.Scope } : {}),
      createdAt,
      // A 2.x row without expiry reads as expired at its creation.
      expiresAt: toDate(t.ExpiresAt) ?? createdAt,
      ...(lastUsedAt !== null ? { lastUsedAt } : {}),
      ...(t.LastUsedIp ? { lastUsedIp: t.LastUsedIp } : {}),
    };
  }

  /**
   * Defence in depth for B24/B07 (a token never above its owner); authz-rbac's ceiling stays authoritative at
   * check time. Without a registered RoleSource the roles are stored as given.
   */
  protected async ownerHolds(owner: IdentityRef, roles: readonly string[]): Promise<boolean> {
    // Resolving an unregistered abstract class builds it bare and records it under its own name.
    if (!(DI.getRegisteredTypes(RoleSource) ?? []).some((t) => t !== RoleSource)) {
      return true;
    }
    const source = await DI.resolve(RoleSource);
    if (typeof source?.rolesOf !== 'function') {
      throw new Error('The registered RoleSource has no rolesOf()');
    }

    const principal: Principal = { type: owner.type, id: owner.id, authenticated: true, source: 'token', attributes: {} };
    const held = new Set((await source.rolesOf(principal)).map((r) => r.role));
    return roles.every((r) => held.has(r));
  }

  protected async publish(ctx: AuthnContext, now: number, type: 'token.create' | 'token.revoke', owner: IdentityRef, data: Record<string, unknown>, actor?: PrincipalRef): Promise<void> {
    const event: AuthnEvent = {
      type,
      at: new Date(now),
      outcome: 'success',
      identity: { type: owner.type, id: owner.id },
      ...(actor ? { actor } : {}),
      ...(ctx.ip !== undefined ? { ip: ctx.ip } : {}),
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
      data,
    };

    // Resolved per event, so a sink registered after this service still gets it.
    const sinks = await DI.resolve(Array.ofType(AuthnEventSink));
    for (const sink of sinks ?? []) {
      // The token is stored or revoked by now; a failing sink must not make the caller lose the plaintext or retry.
      try {
        await sink.publish(event);
      } catch (err) {
        this.Log.error(err as Error, `AuthnEventSink ${sink.constructor.name} failed to publish ${type}`);
      }
    }
  }

  private nowOf(ctx: AuthnContext): number {
    const now = instant(ctx?.now);
    if (!Number.isFinite(now)) {
      throw new Error('ctx.now must be a valid Date');
    }
    return now;
  }

  private checkGenerated(plaintext: unknown): void {
    const suffix = typeof plaintext === 'string' && plaintext.startsWith(this.Prefix) ? plaintext.slice(this.Prefix.length) : '';
    if (!BASE64URL.test(suffix) || suffix.length < Math.ceil((this.Length * 4) / 3)) {
      throw new Error('authn.token.generation minted a token without the configured prefix or length');
    }
  }

  private positive(value: unknown, key: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`authn.token.${key} must be a positive number`);
    }
    return value;
  }

  private affected(result: unknown): number {
    const rows = (result as { RowsAffected?: unknown } | undefined)?.RowsAffected;
    if (typeof rows !== 'number') {
      throw new Error('The database driver did not report the number of updated rows');
    }
    return rows;
  }
}
