import { createHash } from 'node:crypto';
import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { AuthnAudit } from '@spinajs/authn/audit';
import type { AuthnAuditor, AuthnEventBody } from '@spinajs/authn/audit';
import { AuthnThrottle, KeyRegistry, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Ceiling, IdentityRef, KeyChallengeRequest, KeyChallengeResult, KeyMaterial, KeyOwner, KeyRecord, KeyRegisterResult, KeyRegistration, PrincipalRef } from '@spinajs/authn/contracts';
import { _between, _contains, _is_string, _try_check_arg, isPlainObject } from '@spinajs/util';
import { InvalidArgument, InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';
import { challengeId, challengeSecretPurpose, isChallengeNonce, newChallengeRid, parseChallengeId, verifyChallengeSignature } from '../challenge/challenge.js';
import { checkPublicJwk, isValidKid, thumbprint } from '../jwk/keys.js';
import { keysOptionsOf } from '../options/options.js';
import type { KeysConfig, KeysOptions } from '../options/options.js';
import { decodeCeiling, encodeCeiling, encodePrincipalRef, KeyStore } from './store.js';

const OWNER_TYPES: readonly string[] = ['user', 'service', 'agent'];
const MAX_OWNER_ID = 64;
const MAX_NAME = 128;
const TOUCH_INTERVAL_MS = 60_000;
const MAX_CREATED_BY = 100;
const CEILING_KEYS = ['roles', 'permissions', 'resources', 'expiresAt', 'reason'];

const nonEmpty = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function ownerOf(v: unknown): KeyOwner {
  const o: Record<string, unknown> = isPlainObject(v) ? v : {};
  const [typeOk, type] = _try_check_arg(_is_string(_contains(OWNER_TYPES)))(o.type, 'owner.type');
  const [idOk, id] = _try_check_arg(_is_string(_between(1, MAX_OWNER_ID)))(o.id, 'owner.id');
  if (!typeOk || !idOk) {
    throw new InvalidArgument('a key owner is a user, a service or an agent with an id of 1-64 characters');
  }
  return Object.freeze({ type: type as KeyOwner['type'], id: id as string });
}

/** An actor that fits authn_key.created_by (varchar 100). */
function principalRefOf(v: unknown): PrincipalRef | null {
  const o: Record<string, unknown> = isPlainObject(v) ? v : {};
  const [typeOk, type] = _try_check_arg(_is_string(_between(1, MAX_CREATED_BY)))(o.type, 'actor.type');
  const [idOk, id] = _try_check_arg(_is_string(_between(1, MAX_CREATED_BY)))(o.id, 'actor.id');
  if (!typeOk || !idOk) {
    return null;
  }
  const ref = Object.freeze({ type: type as string, id: id as string });
  return encodePrincipalRef(ref).length <= MAX_CREATED_BY ? ref : null;
}

const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The Ceiling shape (design §5), so a malformed scope never reaches storage. */
function isCeiling(v: unknown): v is Ceiling {
  if (!isPlainObject(v) || Object.keys(v).some((k) => !CEILING_KEYS.includes(k))) {
    return false;
  }
  const resources = v.resources;
  return (v.roles === undefined || strings(v.roles)) && (v.permissions === undefined || strings(v.permissions)) && (resources === undefined || (Array.isArray(resources) && resources.every((r) => isPlainObject(r) && typeof r.type === 'string' && (r.id === undefined || typeof r.id === 'string')))) && (v.expiresAt === undefined || (v.expiresAt instanceof Date && !Number.isNaN(v.expiresAt.getTime()))) && (v.reason === undefined || typeof v.reason === 'string');
}

/** Usable for verification: neither revoked nor expired at `now`. */
export const isUsableKey = (key: KeyRecord, now: Date): boolean => !key.revokedAt && (!key.expiresAt || now.getTime() < key.expiresAt.getTime());

/**
 * A login challenge is stored for the key it names; a name that is not a kid still gets a challenge of the same shape
 * (A02), stored under a digest so anonymous input never becomes a long identity id.
 */
export const loginChallengeIdentity = (kid: string): IdentityRef => ({ type: 'key', id: isValidKid(kid) ? kid : createHash('sha256').update(kid, 'utf8').digest('hex') });

/** A test seam for building the registry with `new`: each field replaces what DI injects. */
export interface DefaultKeyRegistryDeps {
  readonly store?: KeyStore;
  readonly secrets?: SecretStore;
  readonly throttle?: AuthnThrottle;
  /** Published to instead of the container's AuthnAudit. */
  readonly audit?: AuthnAuditor;
  /** Complete options that bypass the configuration. */
  readonly options?: KeysOptions;
}

/** KeyRegistry over a KeyStore, challenges in SecretStore (lane notes D7, D12). */
@Injectable(KeyRegistry)
export class DefaultKeyRegistry extends KeyRegistry {
  @Config('authn.keys')
  protected KeysConfig: KeysConfig;

  @Autoinject(AuthnAudit)
  protected Audit: AuthnAudit;

  @Autoinject(KeyStore)
  protected Store: KeyStore;

  @Autoinject(SecretStore)
  protected Secrets: SecretStore;

  @Autoinject(AuthnThrottle)
  protected Throttle: AuthnThrottle;

  private readonly stamped = new Map<string, number>();

  /** Kids whose last stamp is remembered; past this the least recently stamped is forgotten and costs one extra write. */
  protected readonly maxStamped: number = 10_000;

  constructor(protected readonly Deps?: DefaultKeyRegistryDeps) {
    super();
  }

  protected get store(): KeyStore {
    return this.Deps?.store ?? this.Store;
  }

  protected get secrets(): SecretStore {
    return this.Deps?.secrets ?? this.Secrets;
  }

  protected get throttle(): AuthnThrottle {
    return this.Deps?.throttle ?? this.Throttle;
  }

  protected get options(): KeysOptions {
    return keysOptionsOf(this.Deps?.options ?? this.KeysConfig);
  }

  protected publish(ctx: AuthnContext, e: AuthnEventBody): Promise<void> {
    return (this.Deps?.audit ?? this.Audit).publishIn(ctx, e);
  }

  /** The new key's signature over a 'register' challenge issued to this user; the challenge is redeemed only after the signature holds. */
  protected async proofHolds(owner: KeyOwner, key: KeyMaterial, proof: unknown): Promise<boolean> {
    if (!isPlainObject(proof)) {
      return false;
    }
    const parsed = parseChallengeId(proof.challengeId);
    const audience = this.options.challenge.audience;
    if (!parsed || audience === null || !verifyChallengeSignature(key, parsed.nonce, 'register', audience, proof.signature)) {
      return false;
    }
    return this.secrets.redeem({ type: 'user', id: owner.id }, challengeSecretPurpose(parsed.rid), parsed.nonce);
  }

  async register(reg: KeyRegistration, ctx: AuthnContext): Promise<KeyRegisterResult> {
    const r = reg as unknown as Record<string, unknown>;
    const owner = ownerOf(r.owner);
    const fail = async (code: 'invalid_key' | 'invalid_proof' | 'duplicate'): Promise<KeyRegisterResult> => {
      await this.publish(ctx, { type: 'key.register', outcome: 'failure', identity: owner, reason: code });
      return { ok: false, code };
    };

    const material = checkPublicJwk(r.jwk, this.options.algorithms);
    const kid = r.kid === undefined && material ? thumbprint(material.jwk) : r.kid;
    const expiresAt = r.expiresAt;
    const badExpiry = expiresAt !== undefined && (!(expiresAt instanceof Date) || !(expiresAt.getTime() > ctx.now.getTime()));
    // Names reach admin terminals (authn:key-list): no control characters.
    const badName = r.name !== undefined && (!nonEmpty(r.name, MAX_NAME) || /[\u0000-\u001f\u007f-\u009f]/.test(r.name));
    const badScope = r.scope !== undefined && !isCeiling(r.scope);
    if (!material || !isValidKid(kid) || badExpiry || badName || badScope) {
      return fail('invalid_key');
    }

    let createdBy: PrincipalRef | undefined;
    if (owner.type === 'user') {
      if (!(await this.proofHolds(owner, material, r.proof))) {
        return fail('invalid_proof');
      }
    } else {
      const actor = principalRefOf(r.actor);
      if (!actor) {
        throw new InvalidArgument('a service or agent key is registered by an actor (admin route or CLI)');
      }
      createdBy = actor;
    }

    const key = {
      ...material,
      kid,
      owner,
      thumbprint: thumbprint(material.jwk),
      ...(r.name !== undefined ? { name: r.name as string } : {}),
      // A copy through the stored form, so the memory store keeps what the ORM store would return.
      ...(r.scope !== undefined ? { scope: decodeCeiling(encodeCeiling(r.scope as Ceiling)) } : {}),
      createdAt: ctx.now,
      ...(createdBy ? { createdBy } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt as Date } : {}),
    } as KeyRecord;
    if ((await this.store.insert(key)) === 'duplicate') {
      return fail('duplicate');
    }
    const stored = (await this.store.get(kid)) ?? key;
    await this.publish(ctx, { type: 'key.register', outcome: 'success', identity: owner, ...(createdBy ? { actor: createdBy } : {}), data: { kid, thumbprint: stored.thumbprint, alg: stored.alg } });
    return { ok: true, key: stored };
  }

  async list(owner: IdentityRef): Promise<readonly KeyRecord[]> {
    return this.store.listByOwner(owner);
  }

  async revoke(owner: IdentityRef, kid: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    const done = isValidKid(kid) ? await this.store.revoke(owner, kid, ctx.now) : 'none';
    if (done === 'none') {
      return false;
    }
    if (done === 'already') {
      return true;
    }
    await this.publish(ctx, { type: 'key.revoke', outcome: 'success', identity: owner, ...(opts?.actor ? { actor: opts.actor } : {}), data: { kid } });
    return true;
  }

  async byId(kid: string): Promise<KeyRecord | null> {
    return isValidKid(kid) ? this.store.get(kid) : null;
  }

  /** Stamps last_used_at after a successful verification, at most once a minute per key so busy clients write little. */
  async touch(kid: string, at: Date): Promise<void> {
    const last = this.stamped.get(kid);
    if (last !== undefined && at.getTime() - last < TOUCH_INTERVAL_MS && at.getTime() >= last) {
      return;
    }
    this.stamped.delete(kid);
    if (this.stamped.size >= this.maxStamped) {
      this.stamped.delete(this.stamped.keys().next().value!);
    }
    this.stamped.set(kid, at.getTime());
    await this.store.touch(kid, at);
  }

  async challenge(req: KeyChallengeRequest, ctx: AuthnContext): Promise<KeyChallengeResult> {
    const r = req as unknown as Record<string, unknown>;
    let identity: IdentityRef;
    if (r.purpose === 'register') {
      const owner = ownerOf(r.owner);
      if (owner.type !== 'user') {
        throw new InvalidArgument('register challenges are issued to users; services and agents register without a proof');
      }
      identity = owner;
    } else if (r.purpose === 'login' && typeof r.kid === 'string') {
      if (ctx.ip) {
        const t = await this.throttle.attempt([{ kind: 'ip', value: ctx.ip }], 'login', ctx);
        if (!t.allowed) {
          return { ok: false, retryAfterSeconds: t.retryAfterSeconds };
        }
      }
      identity = loginChallengeIdentity(r.kid);
    } else {
      throw new InvalidArgument('a key challenge is { purpose: register, owner } or { purpose: login, kid }');
    }
    const { ttlSeconds: ttl, audience } = this.options.challenge;
    if (audience === null) {
      throw new InvalidOption('authn.keys.challenge.audience (or authn.keys.assertion.audience) must be set to issue key challenges');
    }
    const rid = newChallengeRid();
    const nonce = await this.secrets.issue(identity, challengeSecretPurpose(rid), ttl);
    if (!isChallengeNonce(nonce)) {
      throw new UnexpectedServerError('the SecretStore must issue base64url secrets of at least 128 bits for key challenges');
    }
    return { ok: true, challenge: Object.freeze({ id: challengeId(rid, nonce), nonce, expiresAt: new Date(ctx.now.getTime() + ttl * 1000) }) };
  }
}
