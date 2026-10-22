import { Autoinject, Injectable } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import '../register-schema.js';
import { AuthnAudit } from '@spinajs/authn/audit';
// Registers the default CredentialChangeBus.
import '@spinajs/authn/bus';
import type { AuthnAuditor } from '@spinajs/authn/audit';
import { InvalidArgument, InvalidOperation, UnexpectedServerError } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Orm } from '@spinajs/orm';
import { _between, _check_arg, _contains, _custom, _finite, _gte, _integer, _is_array, _is_array_of, _is_number, _is_string, _max_length, _non_empty, _try_check_arg, isNonEmptyString, isPlainObject, toEpochMs } from '@spinajs/util';
import { CredentialChangeBus, IdentityStore, RoleSource, TokenService } from '@spinajs/authn/contracts';
import { isValidField, tokenIdField, tokenSecretField } from '@spinajs/authn/schemas';
import type { AuthnContext, CredentialChange, AuthnFailure, Ceiling, IdentityRef, Principal, PrincipalRef, ResourceRef, TokenCreateOptions, TokenCreateResult, TokenKind, TokenRecord, TokenRotateResult, TokenScope, TokenUpdate, TokenUpdateResult, TokenValidation } from '@spinajs/authn/contracts';
import { DateTime } from 'luxon';

import { AccessTokenGenerationProvider } from '../generation.js';
import { MAX_TOKEN_LENGTH, checkTokenSize } from '../generator.js';
import { AccessToken, TOKEN_KINDS } from '../models/AccessToken.js';
import { DEFAULT_TOKEN_CACHE, TokenValidationCache } from './cache.js';
import type { TokenCacheConfig, ValidatedToken } from './cache.js';
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
/** The longest grace a rotation may leave the old secret: seven days. */
const MAX_GRACE_SECONDS = 604_800;
/** Ids per DELETE, well under the bound-parameter limits of the drivers. */
const DELETE_BATCH = 500;

type Refusal = Extract<TokenCreateResult, { ok: false }>;
type Failure = Extract<TokenValidation, { ok: false }>;

const INVALID_SCOPE: Refusal = Object.freeze({ ok: false, code: 'invalid_scope' });
const INVALID_EXPIRY: Refusal = Object.freeze({ ok: false, code: 'invalid_expiry' });
const NOT_FOUND: Extract<TokenRotateResult, { ok: false }> = Object.freeze({ ok: false, reason: 'not_found' });
const UPDATE_INVALID_SCOPE: Extract<TokenUpdateResult, { ok: false }> = Object.freeze({ ok: false, reason: 'invalid_scope' });
const UPDATE_INVALID_EXPIRY: Extract<TokenUpdateResult, { ok: false }> = Object.freeze({ ok: false, reason: 'invalid_expiry' });
const fail = (reason: AuthnFailure): Failure => ({ ok: false, reason });

/** NaN for anything but a valid Date. */
const instant = (v: unknown): number => toEpochMs(v) ?? Number.NaN;

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
  const [ok, valid] = _try_check_arg(_is_array(), _non_empty(), _is_array_of(_is_string(_non_empty(), _custom((r: string) => !r.includes(',')))))(roles, 'roles');
  if (!ok) {
    return null;
  }
  const unique = [...new Set(valid as string[])];
  // Postgres and strict mysql would throw on overflow; non-strict mysql would cut the last role to another name.
  return unique.join(',').length <= MAX_ROLES_LENGTH ? unique : null;
}

/** Keeps only the known keys; undefined: no limits; null: malformed. */
function parseScope(scope: unknown, agent: boolean): TokenScope | undefined | null {
  if (scope === undefined) {
    return undefined;
  }
  if (!isPlainObject(scope)) {
    return null;
  }

  const out: { permissions?: string[]; resources?: ResourceRef[]; agent?: boolean } = {};

  if (scope.permissions !== undefined) {
    const [ok, permissions] = _try_check_arg(_is_array(), _max_length(MAX_SCOPE_ENTRIES), _is_array_of(_is_string(_non_empty())))(scope.permissions, 'scope.permissions');
    if (!ok) {
      return null;
    }
    out.permissions = [...(permissions as string[])];
  }

  if (scope.resources !== undefined) {
    const [ok, entries] = _try_check_arg(_is_array(), _max_length(MAX_SCOPE_ENTRIES))(scope.resources, 'scope.resources');
    if (!ok) {
      return null;
    }
    const resources: ResourceRef[] = [];
    for (const r of entries as unknown[]) {
      if (!isPlainObject(r) || !isNonEmptyString(r.type) || (r.id !== undefined && typeof r.id !== 'string')) {
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

/** The trimmed name; InvalidArgument for anything but 1 to 128 characters. */
function checkedName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  _check_arg(_between(1, MAX_NAME_LENGTH, new InvalidArgument(`token name must be 1 to ${MAX_NAME_LENGTH} characters`)))(name, 'name');
  return name;
}

/** The columns an update writes and the names of the fields it changes. */
function updateValues(name: string | undefined, roles: string[] | undefined, expiresAt: number | undefined): { values: Partial<AccessToken>; fields: string[] } {
  const values: Partial<AccessToken> = {
    ...(name !== undefined ? { Name: name } : {}),
    ...(roles !== undefined ? { Roles: roles } : {}),
    ...(expiresAt !== undefined ? { ExpiresAt: DateTime.fromMillis(expiresAt) as DateTime<true> } : {}),
  };
  const fields = [name !== undefined && 'name', roles !== undefined && 'roles', expiresAt !== undefined && 'expiresAt'].filter((f): f is string => f !== false);
  return { values, fields };
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
  if (!isPlainObject(stored) || (agent ? stored.agent !== true : stored.agent !== undefined && stored.agent !== false)) {
    return null;
  }
  // parseScope drops unknown keys; on the read path an unknown key (a typo, a ceiling field such as roles) must not
  // turn into "no limits".
  if (!onlyKeys(stored, SCOPE_KEYS) || (Array.isArray(stored.resources) && !stored.resources.every((r) => isPlainObject(r) && onlyKeys(r, RESOURCE_KEYS)))) {
    return null;
  }
  return parseScope(stored, agent);
}

/**
 * `TokenService` over `rbac_access_tokens`. Owners map to `user_id` through {@link TokenOwnerResolver};
 * owner status comes from {@link IdentityStore}. A successful validate is served from memory for
 * `authn.token.cache.ttlSeconds`; revocations, rotations and updates evict it and go out on the {@link CredentialChangeBus}.
 */
@Injectable(TokenService)
export class DbTokenService extends TokenService {
  /** Never read: injecting it resolves the Orm, which binds `AccessToken`, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  @Config('authn.token.maxTtlDays')
  protected MaxTtlDays: number;

  @Config('authn.token.agentMaxTtlMinutes')
  protected AgentMaxTtlMinutes: number;

  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
  protected Length: number;

  @Config('authn.token.cache', { defaultValue: DEFAULT_TOKEN_CACHE })
  protected CacheConfig: TokenCacheConfig;

  @Logger('authn-token')
  protected Log: Log;

  @Autoinject(AuthnAudit)
  protected Audit: AuthnAudit;

  @Autoinject(TokenOwnerResolver, { check: true })
  protected Owners: TokenOwnerResolver;

  @Autoinject(TokenProfilePolicy, { check: true })
  protected Profiles: TokenProfilePolicy;

  @Autoinject(IdentityStore, { check: true })
  protected Identities: IdentityStore;

  @Autoinject(RoleSource, { optional: true })
  protected Roles: RoleSource | undefined;

  @Autoinject(CredentialChangeBus, { optional: true })
  protected Bus: CredentialChangeBus | undefined;

  private validations: TokenValidationCache | undefined;

  @AutoinjectService('authn.token.generation', AccessTokenGenerationProvider)
  protected Generator: AccessTokenGenerationProvider;

  /** `Auditor`: a test seam, published to instead of the container's AuthnAudit. */
  constructor(protected readonly Auditor?: AuthnAuditor) {
    super();
  }

  /** Built on first use, once the configuration and the bus are injected. */
  protected get cache(): TokenValidationCache {
    return (this.validations ??= new TokenValidationCache(this.CacheConfig ?? DEFAULT_TOKEN_CACHE, this.Bus));
  }

  /** The format size cap; checked at each create, because this service has no boot hook. */
  protected checkFormat(): void {
    checkTokenSize(this.Prefix, this.Length);
  }

  public async create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult> {
    this.checkFormat();
    const now = this.nowOf(ctx);

    // Callers can bypass the types, so every field is checked as unknown.
    const raw: Record<string, unknown> = isPlainObject(opts) ? opts : {};
    const [knownKind, kind] = _try_check_arg(_is_string(_contains(TOKEN_KINDS)))(raw.kind, 'kind');
    if (!knownKind) {
      return INVALID_SCOPE;
    }

    const agent = kind === 'agent';
    if (agent) {
      if (!isPlainObject(raw.scope) || raw.scope.agent !== true || raw.roles !== undefined || raw.profile !== undefined) {
        return INVALID_SCOPE;
      }
    } else if (isPlainObject(raw.scope) && raw.scope.agent === true) {
      return INVALID_SCOPE;
    }

    const roles = parseRoles(raw.roles);
    const scope = parseScope(raw.scope, agent);
    if (roles === null || scope === null) {
      return INVALID_SCOPE;
    }

    let profile: string | undefined;
    if (raw.profile !== undefined) {
      const [ok, requested] = _try_check_arg(_is_string(_non_empty()))(raw.profile, 'profile');
      if (!ok || !(await this.Profiles.allowedProfiles(owner)).includes(requested)) {
        return INVALID_SCOPE;
      }
      profile = requested;
    }

    const expiresAt = instant(raw.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return INVALID_EXPIRY;
    }
    const patCap = now + this.MaxTtlDays * DAY_MS;
    const agentCap = now + this.AgentMaxTtlMinutes * MINUTE_MS;
    const cap = agent ? Math.min(patCap, agentCap) : patCap;
    // The schema is the gate; this floor holds for values that never went through it. Each cap is checked on its own: Math.min would hide an infinite agent cap behind the PAT cap.
    if (!(Number.isFinite(patCap) && (!agent || Number.isFinite(agentCap)) && expiresAt > now && expiresAt <= cap)) {
      return INVALID_EXPIRY;
    }

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    _check_arg(_between(1, MAX_NAME_LENGTH, new InvalidArgument(`token name must be 1 to ${MAX_NAME_LENGTH} characters`)))(name, 'name');

    const rowId = await this.Owners.rowIdOf(owner);
    if (rowId === null) {
      throw new InvalidOperation(`Token owner ${String(owner?.type)}:${String(owner?.id)} is unknown to ${this.Owners.constructor.name}`);
    }

    if (roles !== undefined && !(await this.ownerHolds(owner, roles))) {
      return INVALID_SCOPE;
    }

    const generated = await this.Generator.generate();
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
    const rowId = await this.Owners.rowIdOf(owner);
    if (rowId === null) {
      return [];
    }

    const rows = await AccessToken.where('user_id', rowId).whereNull('RevokedAt');
    return rows.map((t) => this.recordOf(t, owner));
  }

  public async revoke(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    const now = this.nowOf(ctx);
    const [ok] = _try_check_arg(_is_string(_non_empty()))(id, 'id');
    if (!ok || !isValidField(tokenIdField, id)) {
      return false;
    }
    const rowId = await this.Owners.rowIdOf(owner);
    if (rowId === null) {
      return false;
    }

    const token = await this.revokeRow(id, now, rowId);
    if (!token) {
      return false;
    }

    await this.changed({ kind: 'token', id: token.Uuid });
    await this.publish(ctx, now, 'token.revoke', owner, { token: token.Uuid, kind: token.Kind }, opts?.actor);
    return true;
  }

  public async rotate(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly graceSeconds?: number }): Promise<TokenRotateResult> {
    const now = this.nowOf(ctx);
    const graceSeconds = opts?.graceSeconds === undefined ? 0 : opts.graceSeconds;
    _check_arg(_is_number(_integer(), _between(0, MAX_GRACE_SECONDS, new InvalidArgument(`graceSeconds must be a whole number of seconds from 0 to ${MAX_GRACE_SECONDS}`))))(graceSeconds, 'graceSeconds');
    this.checkFormat();

    const token = await this.liveToken(owner, id);
    const expiresAt = token ? toDate(token.ExpiresAt) : null;
    if (!token || expiresAt === null || expiresAt.getTime() <= now) {
      return NOT_FOUND;
    }

    const generated = await this.Generator.generate();
    this.checkGenerated(generated?.Plaintext);

    const grace = graceSeconds > 0;
    const values = {
      Token: generated.Hash,
      PreviousToken: grace ? token.Token : null,
      PreviousValidUntil: grace ? DateTime.fromMillis(now + graceSeconds * 1000) : null,
    } as unknown as Partial<AccessToken>;
    // Conditional on the stored hash, so of two racing rotations only one wins and no caller holds a secret that is already dead.
    const result = await AccessToken.update(values)
      .where('Id', token.Id)
      .where('Token', token.Token)
      .whereNull('RevokedAt');
    if (this.affected(result) === 0) {
      return NOT_FOUND;
    }

    await this.changed({ kind: 'token', id: token.Uuid });
    await this.publish(ctx, now, 'token.rotate', owner, { token: token.Uuid, kind: token.Kind, graceSeconds });
    return { ok: true, plaintext: generated.Plaintext, token: this.recordOf(token, owner) };
  }

  public async update(owner: IdentityRef, id: string, change: TokenUpdate, ctx: AuthnContext): Promise<TokenUpdateResult> {
    const now = this.nowOf(ctx);
    // Callers can bypass the types, and only these three keys are read.
    const raw: Record<string, unknown> = isPlainObject(change) ? change : {};
    const name = raw.name === undefined ? undefined : checkedName(raw.name);
    const roles = parseRoles(raw.roles);
    const expiresAt = raw.expiresAt === undefined ? undefined : instant(raw.expiresAt);

    const token = await this.liveToken(owner, id);
    if (!token) {
      return NOT_FOUND;
    }
    const refusal = await this.narrowingRefusal(owner, token, roles, expiresAt, now);
    if (refusal) {
      return refusal;
    }

    const { values, fields } = updateValues(name, roles ?? undefined, expiresAt);
    if (fields.length === 0) {
      return { ok: true, token: this.recordOf(token, owner) };
    }
    const result = await AccessToken.update(values).where('Id', token.Id).whereNull('RevokedAt');
    if (this.affected(result) === 0) {
      return NOT_FOUND;
    }
    Object.assign(token, values);

    await this.changed({ kind: 'token', id: token.Uuid });
    await this.publish(ctx, now, 'token.update', owner, { token: token.Uuid, kind: token.Kind, fields });
    return { ok: true, token: this.recordOf(token, owner) };
  }

  /**
   * Revokes a token whoever owns it, for operator tools such as `authn:token-delete`. Not part of the TokenService
   * contract, which only revokes on behalf of an owner.
   */
  public async revokeById(id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    const now = this.nowOf(ctx);
    const [ok] = _try_check_arg(_is_string(_non_empty()))(id, 'id');
    if (!ok || !isValidField(tokenIdField, id)) {
      return false;
    }

    const token = await this.revokeRow(id, now);
    if (!token) {
      return false;
    }
    await this.changed({ kind: 'token', id: token.Uuid });

    // The owner only names the event's identity; a failing lookup must not undo or hide the revocation.
    let owner: IdentityRef | null = null;
    try {
      owner = await this.Owners.refOf(token.user_id);
    } catch (err) {
      this.Log.error({ error: err, tokenUuid: token.Uuid }, 'Owner lookup failed for revoked token ${tokenUuid}; publishing token.revoke without an identity');
    }

    await this.publish(ctx, now, 'token.revoke', owner, { token: token.Uuid, kind: token.Kind }, opts?.actor);
    return true;
  }

  /**
   * Housekeeping: deletes tokens that expired at or before `now`, revoked ones and rows without an expiry, which never
   * validate (SR-08); returns how many.
   */
  public async deleteExpired(now: Date): Promise<number> {
    const at = instant(now);
    if (!Number.isFinite(at)) {
      throw new InvalidOperation('now must be a valid Date');
    }
    const cutoff = DateTime.fromMillis(at);

    // Selected through the model, so the cutoff is written in the column's stored format; a bare DELETE on the
    // connection would convert it by value type only. A selected row cannot become live again, so deleting by id is
    // safe against concurrent writes. Only ids are read: a row that no longer hydrates must not stop the sweep.
    const due = () =>
      AccessToken.where(function () {
        this.whereNull('ExpiresAt');
        this.orWhere(function () {
          this.where('ExpiresAt', '<=', cutoff);
        });
        this.orWhere(function () {
          this.whereNotNull('RevokedAt');
        });
      })
        .select('Id')
        // MSSQL pages with OFFSET ... FETCH, which needs an ORDER BY.
        .orderBy('Id')
        .take(DELETE_BATCH)
        .asRaw<Array<{ Id: number }>>();

    let count = 0;
    for (;;) {
      const doomed = await due();
      if (doomed.length === 0) {
        break;
      }

      const deleted = this.affected(await AccessToken.destroy(doomed.map((t) => t.Id)));
      count += deleted;
      if (doomed.length < DELETE_BATCH || deleted === 0) {
        break;
      }
    }

    return count;
  }

  public async revokeAllFor(owner: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<number> {
    const now = this.nowOf(ctx);
    const rowId = await this.Owners.rowIdOf(owner);
    if (rowId === null) {
      return 0;
    }

    // Agent tokens acting for the owner carry the owner's user_id, so they are included.
    const result = await AccessToken.update({ RevokedAt: DateTime.fromMillis(now) as DateTime<true> })
      .where('user_id', rowId)
      .whereNull('RevokedAt');
    const count = this.affected(result);
    if (count > 0) {
      await this.changed({ kind: 'identity', identity: owner });
    }

    await this.publish(ctx, now, 'token.revoke', owner, { count }, opts?.actor);
    return count;
  }

  public async revokeByPlaintext(raw: string, ctx: AuthnContext): Promise<boolean> {
    const now = this.nowOf(ctx);
    const [ok] = _try_check_arg(_is_string(_non_empty()))(raw, 'raw');
    if (!ok || raw.length > MAX_TOKEN_LENGTH) {
      return false;
    }

    const hash = this.Generator.hash(raw);
    const found = await this.Owners.tokenByHash(hash);
    if (!found) {
      return false;
    }
    const { token, owner } = found;
    // The previous secret is a credential only until PreviousValidUntil, like in validate.
    if (token.Token !== hash) {
      const until = toDate(token.PreviousValidUntil);
      if (token.PreviousToken !== hash || until === null || until.getTime() <= now) {
        return false;
      }
    }

    const revoked = await this.revokeRow(token.Uuid, now);
    if (!revoked) {
      return false;
    }
    await this.changed({ kind: 'token', id: revoked.Uuid });
    await this.publish(ctx, now, 'token.revoke', owner, { token: revoked.Uuid, kind: revoked.Kind }, undefined, 'self');
    return true;
  }

  public async validate(raw: string, ctx: AuthnContext): Promise<TokenValidation> {
    // Without a valid now no token could ever count as expired.
    const now = instant(ctx?.now);
    const [ok] = _try_check_arg(_is_string(_non_empty()))(raw, 'raw');
    if (!ok || !Number.isFinite(now) || !isValidField(tokenSecretField, raw)) {
      return fail('invalid_credentials');
    }

    const hash = this.Generator.hash(raw);
    const cached = this.cache.get(hash, now);
    if (cached) {
      return cached;
    }
    const since = this.cache.mark();

    const found = await this.Owners.tokenByHash(hash);
    if (!found) {
      return fail('invalid_credentials');
    }
    const { token, owner } = found;
    // A match on the previous hash counts only until PreviousValidUntil, and a stored hash that differs from the
    // presented one in case or padding (a collation quirk) matches nothing.
    let graceEndsAt = Number.POSITIVE_INFINITY;
    if (token.Token !== hash) {
      const until = toDate(token.PreviousValidUntil);
      if (token.PreviousToken !== hash || until === null || until.getTime() <= now) {
        return fail('invalid_credentials');
      }
      graceEndsAt = until.getTime();
    }
    if (token.RevokedAt) {
      return fail('revoked');
    }

    // A null expiry is expired, never eternal (SR-08).
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

    if (owner === null) {
      return fail('invalid_credentials');
    }
    const status = await this.Identities.status(owner);
    if (!(status.exists && status.active && !status.banned && !status.deleted)) {
      return fail('invalid_credentials');
    }
    if (token.Profile && !(await this.Profiles.allowedProfiles(owner)).includes(token.Profile)) {
      return fail('invalid_credentials');
    }

    const record = this.recordOf(token, owner);
    const limits: Pick<Ceiling, 'permissions' | 'resources'> = {
      ...(scope?.permissions !== undefined ? { permissions: scope.permissions } : {}),
      ...(scope?.resources !== undefined ? { resources: scope.resources } : {}),
    };

    const validation = agent ? this.agentValidation(record, owner, limits) : this.ownerValidation(record, owner, limits);
    this.cache.set(hash, validation, Math.min(expiresAt.getTime(), graceEndsAt), since);
    return validation;
  }

  private agentValidation(record: TokenRecord, owner: IdentityRef, limits: Pick<Ceiling, 'permissions' | 'resources'>): ValidatedToken {
    return {
      ok: true,
      identity: { type: 'agent', id: record.id },
      method: 'token',
      ceiling: { ...limits, reason: 'out_of_scope' },
      delegation: { onBehalfOf: owner, mode: 'inherit' },
      token: record,
    };
  }

  private ownerValidation(record: TokenRecord, owner: IdentityRef, limits: Pick<Ceiling, 'permissions' | 'resources'>): ValidatedToken {
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
    const [validInterval] = _try_check_arg(_is_number(_finite(), _gte(0)))(intervalSeconds, 'intervalSeconds');
    if (!validInterval) {
      throw new InvalidOperation('the last-used interval must be a non-negative number of seconds');
    }
    const [ok] = _try_check_arg(_is_string(_non_empty()))(id, 'id');
    if (!ok) {
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
    const wrote = this.affected(result) > 0;
    // Also when another request wrote first: the stored stamp is then younger than the interval either way.
    this.cache.stamp(id, new Date(now), ip);
    return wrote;
  }

  protected recordOf(t: AccessToken, owner: IdentityRef): TokenRecord {
    // The Set converter reads an empty column back as [''].
    const roles = (t.Roles ?? []).filter(isNonEmptyString);
    const createdAt = toDate(t.CreatedAt);
    if (createdAt === null) {
      throw new UnexpectedServerError(`Access token ${t.Uuid} has an unreadable CreatedAt`);
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
      // A row without expiry reads as expired at its creation.
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
    const source = this.Roles;
    if (source === undefined) {
      return true;
    }
    if (typeof source.rolesOf !== 'function') {
      throw new InvalidOperation('The registered RoleSource has no rolesOf()');
    }

    const principal: Principal = { type: owner.type, id: owner.id, authenticated: true, source: 'token', attributes: {} };
    const held = new Set((await source.rolesOf(principal)).map((r) => r.role));
    return roles.every((r) => held.has(r));
  }

  /** Evicts this process's cache, then tells the other caches; a bus failure never undoes the revocation. */
  protected async changed(change: CredentialChange): Promise<void> {
    this.cache.evict(change);
    try {
      await this.Bus?.publish(change);
    } catch (err) {
      this.Log.error({ error: err, kind: change.kind }, 'Could not publish a ${kind} credential change');
    }
  }

  protected publish(ctx: AuthnContext, now: number, type: 'token.create' | 'token.revoke' | 'token.rotate' | 'token.update', owner: IdentityRef | null, data: Record<string, unknown>, actor?: PrincipalRef, reason?: string): Promise<void> {
    return (this.Auditor ?? this.Audit).publishIn({ ...ctx, now: new Date(now) }, {
      type,
      outcome: 'success',
      ...(reason ? { reason } : {}),
      // null: revokeById could not resolve the owner (row gone or lookup failed).
      ...(owner ? { identity: { type: owner.type, id: owner.id } } : {}),
      ...(actor ? { actor } : {}),
      data,
    });
  }

  /** Why `update` cannot make these changes to `token`, or null; a change may only narrow it. */
  private async narrowingRefusal(owner: IdentityRef, token: AccessToken, roles: string[] | undefined | null, expiresAt: number | undefined, now: number): Promise<Extract<TokenUpdateResult, { ok: false }> | null> {
    if (roles === null) {
      return UPDATE_INVALID_SCOPE;
    }
    if (roles !== undefined) {
      const current = (token.Roles ?? []).filter(isNonEmptyString);
      // A token without roles holds all its owner's; pinning it to some narrows it, but only to roles the owner has.
      const allowed = token.Kind === 'agent' ? false : current.length > 0 ? roles.every((r) => current.includes(r)) : await this.ownerHolds(owner, roles);
      if (!allowed) {
        return UPDATE_INVALID_SCOPE;
      }
    }
    if (expiresAt !== undefined && !(expiresAt > now && expiresAt <= (toDate(token.ExpiresAt)?.getTime() ?? 0))) {
      return UPDATE_INVALID_EXPIRY;
    }
    return null;
  }

  /** The unrevoked token `id` of `owner`, or null; an expired one is returned too. */
  private async liveToken(owner: IdentityRef, id: string): Promise<AccessToken | null> {
    const [ok] = _try_check_arg(_is_string(_non_empty()))(id, 'id');
    if (!ok) {
      return null;
    }
    const rowId = await this.Owners.rowIdOf(owner);
    if (rowId === null) {
      return null;
    }
    return (await AccessToken.where('Uuid', id).where('user_id', rowId).whereNull('RevokedAt').first()) ?? null;
  }

  /** Revokes the live token `id`, of the owner's row when `rowId` is given; null when this call revoked nothing. */
  private async revokeRow(id: string, now: number, rowId?: number): Promise<AccessToken | null> {
    const query = AccessToken.where('Uuid', id).whereNull('RevokedAt');
    if (rowId !== undefined) {
      query.where('user_id', rowId);
    }
    const token = await query.first();
    if (!token) {
      return null;
    }

    // Conditional on RevokedAt, so of two concurrent revokes only one answers true.
    const result = await AccessToken.update({ RevokedAt: DateTime.fromMillis(now) as DateTime<true> })
      .where('Id', token.Id)
      .whereNull('RevokedAt');
    return this.affected(result) === 0 ? null : token;
  }

  private nowOf(ctx: AuthnContext): number {
    const now = instant(ctx?.now);
    if (!Number.isFinite(now)) {
      throw new InvalidOperation('ctx.now must be a valid Date');
    }
    return now;
  }

  private checkGenerated(plaintext: unknown): void {
    const suffix = typeof plaintext === 'string' && plaintext.startsWith(this.Prefix) ? plaintext.slice(this.Prefix.length) : '';
    if (!BASE64URL.test(suffix) || suffix.length < Math.ceil((this.Length * 4) / 3) || (plaintext as string).length > MAX_TOKEN_LENGTH) {
      throw new UnexpectedServerError('authn.token.generation minted a token without the configured prefix or length');
    }
  }

  private affected(result: unknown): number {
    const rows = (result as { RowsAffected?: unknown } | undefined)?.RowsAffected;
    if (typeof rows !== 'number') {
      throw new UnexpectedServerError('The database driver did not report the number of updated rows');
    }
    return rows;
  }
}
