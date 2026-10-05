import { DI, Inject, Injectable } from '@spinajs/di';
import { Config, service } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { AuthnEventSink, IdentityStore, RoleSource, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnFailure, Ceiling, IdentityRef, Principal, PrincipalRef, ResourceRef, TokenCreateOptions, TokenCreateResult, TokenKind, TokenRecord, TokenScope, TokenValidation } from '@spinajs/authn/contracts';
import { DateTime } from 'luxon';

import { AccessTokenGenerationProvider } from '../generation.js';
import { MAX_TOKEN_LENGTH, checkTokenSize } from '../generator.js';
import { AccessToken, TOKEN_KINDS } from '../models/AccessToken.js';
import { TokenOwnerResolver } from './owner-resolver.js';
import { TokenProfilePolicy } from './profile-policy.js';

const MAX_NAME_LENGTH = 128;
/** Width of the comma-joined `Roles` column. */
const MAX_ROLES_LENGTH = 512;
const MAX_SCOPE_ENTRIES = 1000;
/** Width of the `LastUsedIp` column. */
const MAX_IP_LENGTH = 64;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Ids per DELETE, well under the bound-parameter limits of the drivers. */
const DELETE_BATCH = 500;

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

const SCOPE_KEYS: readonly string[] = ['permissions', 'resources', 'agent'];
const RESOURCE_KEYS: readonly string[] = ['type', 'id'];

const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every((k) => allowed.includes(k));

/**
 * A stored Scope read back: null when it is malformed or its agent flag disagrees with the row's kind. Rows can be
 * edited outside create, and a scope that read as "no limits" would widen the token.
 */
function storedScope(stored: unknown, agent: boolean): TokenScope | undefined | null {
  if (stored === null || stored === undefined) {
    return agent ? null : undefined;
  }
  if (!isRecord(stored) || (agent ? stored.agent !== true : stored.agent !== undefined && stored.agent !== false)) {
    return null;
  }
  // parseScope drops unknown keys; on the read path an unknown key (a typo, a ceiling field such as roles) must not
  // turn into "no limits".
  if (!onlyKeys(stored, SCOPE_KEYS) || (Array.isArray(stored.resources) && !stored.resources.every((r) => isRecord(r) && onlyKeys(r, RESOURCE_KEYS)))) {
    return null;
  }
  return parseScope(stored, agent);
}

/**
 * `TokenService` over `rbac_access_tokens`. Owners map to `user_id` through {@link TokenOwnerResolver};
 * owner status comes from {@link IdentityStore} on every validate.
 */
@Injectable(TokenService)
@Inject(TokenOwnerResolver, TokenProfilePolicy, IdentityStore)
export class DbTokenService extends TokenService {
  @Config('authn.token.maxTtlDays')
  protected MaxTtlDays: number;

  @Config('authn.token.agentMaxTtlMinutes')
  protected AgentMaxTtlMinutes: number;

  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
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
  }

  /** The format size cap; checked at each create, because a constructor cannot read the container's Configuration. */
  public resolve(): void {
    checkTokenSize(this.Prefix, this.Length);
  }

  public async create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult> {
    this.resolve();
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
    const patCap = now + this.MaxTtlDays * DAY_MS;
    const cap = agent ? Math.min(patCap, now + this.AgentMaxTtlMinutes * MINUTE_MS) : patCap;
    // Written to fail closed: a cap that is not a number (a Configuration.set the schema never saw) refuses every expiry.
    if (!(expiresAt > now && expiresAt <= cap)) {
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

  /**
   * Revokes a token whoever owns it, for operator tools such as `authn:token-delete`. Not part of the TokenService
   * contract, which only revokes on behalf of an owner.
   */
  public async revokeById(id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    const now = this.nowOf(ctx);
    if (!isNonEmptyString(id)) {
      return false;
    }

    const token = await AccessToken.where('Uuid', id).whereNull('RevokedAt').first();
    if (!token) {
      return false;
    }

    const result = await AccessToken.update({ RevokedAt: DateTime.fromMillis(now) as DateTime<true> })
      .where('Id', token.Id)
      .whereNull('RevokedAt');
    if (this.affected(result) === 0) {
      return false;
    }

    // The owner only names the event's identity; a failing lookup must not undo or hide the revocation.
    let owner: IdentityRef | null = null;
    try {
      owner = await this.owners.refOf(token.user_id);
    } catch (err) {
      this.Log.error(err as Error, `Owner lookup failed for revoked token ${token.Uuid}; publishing token.revoke without an identity`);
    }

    await this.publish(ctx, now, 'token.revoke', owner, { token: token.Uuid, kind: token.Kind }, opts?.actor);
    return true;
  }

  /**
   * Housekeeping: deletes tokens that expired at or before `now` and revoked ones; returns how many. Keeps rows
   * without an expiry, because the deprecated 2.x API still writes them and treats them as live.
   */
  public async deleteExpired(now: Date): Promise<number> {
    const at = instant(now);
    if (!Number.isFinite(at)) {
      throw new Error('now must be a valid Date');
    }
    const cutoff = DateTime.fromMillis(at);

    // Selected through the model, so the cutoff is written in the column's stored format; a bare DELETE on the
    // connection would convert it by value type only. A selected row cannot become live again, so deleting by id is
    // safe against concurrent writes. Only ids are read: a row that no longer hydrates must not stop the sweep.
    const doomed = await AccessToken.where(function () {
      this.where(function () {
        this.whereNotNull('ExpiresAt');
        this.where('ExpiresAt', '<=', cutoff);
      });
      this.orWhere(function () {
        this.whereNotNull('RevokedAt');
      });
    })
      .select('Id')
      .asRaw<Array<{ Id: number }>>();

    let count = 0;
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      count += this.affected(await AccessToken.destroy(doomed.slice(i, i + DELETE_BATCH).map((t) => t.Id)));
    }
    return count;
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
    const agent = token.Kind === 'agent';
    const scope = storedScope(token.Scope, agent);
    // An agent acts with its owner's roles narrowed by its scope; a row that also pins roles or a profile was edited.
    if (scope === null || (agent && ((token.Roles ?? []).some(isNonEmptyString) || !!token.Profile))) {
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
      ...(scope?.permissions !== undefined ? { permissions: scope.permissions } : {}),
      ...(scope?.resources !== undefined ? { resources: scope.resources } : {}),
    };

    if (agent) {
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

  /**
   * Stamps LastUsedAt and LastUsedIp unless the stored stamp is younger than `intervalSeconds`; true when it wrote.
   * Not part of the TokenService contract: TokenStrategy calls it after a successful validate.
   */
  public async touch(id: string, ctx: AuthnContext, intervalSeconds: number): Promise<boolean> {
    const now = this.nowOf(ctx);
    if (typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
      throw new Error('the last-used interval must be a non-negative number of seconds');
    }
    if (!isNonEmptyString(id)) {
      return false;
    }

    const ip = typeof ctx.ip === 'string' && ctx.ip.length > 0 ? ctx.ip.slice(0, MAX_IP_LENGTH) : null;
    // The model types LastUsedIp as optional, but a use without an ip must clear the previous one, so null is written.
    const values = { LastUsedAt: DateTime.fromMillis(now) as DateTime<true>, LastUsedIp: ip } as unknown as Partial<AccessToken>;
    const staleBefore = DateTime.fromMillis(now - intervalSeconds * 1000);
    // The interval sits in the WHERE clause, so of several requests racing past the same stale read only one writes.
    const result = await AccessToken.update(values)
      .where('Uuid', id)
      .where(function () {
        this.whereNull('LastUsedAt');
        this.orWhere('LastUsedAt', '<', staleBefore);
      });
    return this.affected(result) > 0;
  }

  protected recordOf(t: AccessToken, owner: IdentityRef): TokenRecord {
    // The Set converter reads an empty column back as [''].
    const roles = (t.Roles ?? []).filter(isNonEmptyString);
    const createdAt = toDate(t.CreatedAt);
    if (createdAt === null) {
      throw new Error(`Access token ${t.Uuid} has an unreadable CreatedAt`);
    }
    const lastUsedAt = toDate(t.LastUsedAt);
    const scope = storedScope(t.Scope, t.Kind === 'agent');

    return {
      id: t.Uuid,
      owner: { type: owner.type, id: owner.id },
      name: t.Name,
      kind: t.Kind,
      ...(roles.length > 0 ? { roles } : {}),
      ...(t.Profile ? { profile: t.Profile } : {}),
      ...(scope ? { scope } : {}),
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

  protected async publish(ctx: AuthnContext, now: number, type: 'token.create' | 'token.revoke', owner: IdentityRef | null, data: Record<string, unknown>, actor?: PrincipalRef): Promise<void> {
    const event: AuthnEvent = {
      type,
      at: new Date(now),
      outcome: 'success',
      // null: revokeById could not resolve the owner (row gone or lookup failed).
      ...(owner ? { identity: { type: owner.type, id: owner.id } } : {}),
      ...(actor ? { actor } : {}),
      ...(ctx.ip !== undefined ? { ip: ctx.ip } : {}),
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
      data,
    };

    // The token is stored or revoked by now; neither a sink that cannot be built nor one that fails may make the caller
    // lose the plaintext or retry.
    let sinks: readonly AuthnEventSink[];
    try {
      // Resolved per event, so a sink registered after this service still gets it.
      sinks = (await DI.resolve(Array.ofType(AuthnEventSink))) ?? [];
    } catch (err) {
      this.Log.error(err as Error, `AuthnEventSink resolution failed; publishing ${type} to the sinks already built`);
      sinks = DI.get(Array.ofType(AuthnEventSink)) ?? [];
    }

    for (const sink of sinks) {
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
    if (!BASE64URL.test(suffix) || suffix.length < Math.ceil((this.Length * 4) / 3) || (plaintext as string).length > MAX_TOKEN_LENGTH) {
      throw new Error('authn.token.generation minted a token without the configured prefix or length');
    }
  }

  private affected(result: unknown): number {
    const rows = (result as { RowsAffected?: unknown } | undefined)?.RowsAffected;
    if (typeof rows !== 'number') {
      throw new Error('The database driver did not report the number of updated rows');
    }
    return rows;
  }
}
