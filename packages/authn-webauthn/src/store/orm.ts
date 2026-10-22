import { createHash } from 'node:crypto';
import { PasskeyChallengesFull } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DbMfaStore, identityKey, parseIdentityKey, readInstant } from '@spinajs/authn-orm';
import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';
import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';
import { Orm, UniqueViolation, everyNthCall } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { WebAuthnCredentialExists, WebAuthnCredentialStore } from '../contracts.js';
import type { WebAuthnCredential } from '../contracts.js';
import { WebAuthnChallengeStore } from '../challenge.js';
import type { WebAuthnCeremony, WebAuthnChallenge } from '../challenge.js';
import { AuthnWebauthnChallenge } from '../models/AuthnWebauthnChallenge.js';
import { AuthnWebauthnCredential } from '../models/AuthnWebauthnCredential.js';
import { WebAuthnRecoveryCodeStore } from '../step/recovery.js';
import { CHALLENGE_ID_MAX, checkedChallenge, checkedCounter, checkedCredential, checkedCredentialId } from './checks.js';

const PURGE_EVERY = 64;
const PURGE_BATCH = 500;

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function utc(at: Date, what: string): DateTime {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new InvalidArgument(`${what} must be a valid date`);
  return DateTime.fromMillis(at.getTime(), { zone: 'utc' });
}

function counterOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new UnexpectedServerError(`DbWebAuthnCredentialStore: counter ${String(value)} is not a counter`);
  return n;
}

function transportsOf(value: string | null | undefined): readonly string[] | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const list: unknown = JSON.parse(value);
  return Array.isArray(list) ? Object.freeze(list.filter((t): t is string => typeof t === 'string')) : undefined;
}

function credentialOf(r: AuthnWebauthnCredential): WebAuthnCredential {
  const transports = transportsOf(r.transports);
  const lastUsedAt = readInstant(r.last_used_at);
  return Object.freeze({
    credentialId: r.credential_id,
    identity: parseIdentityKey(r.identity),
    publicKey: new Uint8Array(Buffer.from(r.public_key, 'base64url')),
    counter: counterOf(r.counter),
    ...(transports ? { transports } : {}),
    ...(r.aaguid ? { aaguid: r.aaguid } : {}),
    ...(r.name !== null && r.name !== undefined ? { name: r.name } : {}),
    createdAt: readInstant(r.created_at) ?? new Date(NaN),
    ...(lastUsedAt && Number.isFinite(lastUsedAt.getTime()) ? { lastUsedAt } : {}),
  });
}

const COLUMNS = ['id_hash', 'credential_id', 'identity', 'public_key', 'counter', 'transports', 'aaguid', 'name', 'created_at', 'last_used_at'];

/**
 * `WebAuthnCredentialStore` on `authn_webauthn_credential`. Rows are keyed by the SHA-256 of the credential id, so an id
 * of any allowed length is unique on every database. Only the `@spinajs/authn-webauthn/db` entry loads it.
 */
@PerChildInstance()
@Injectable(WebAuthnCredentialStore)
export class DbWebAuthnCredentialStore extends WebAuthnCredentialStore {
  /** Never read: injecting it resolves the Orm, which binds the models, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  async add(c: WebAuthnCredential): Promise<void> {
    const row = checkedCredential(c);
    const identity = identityKey(row.identity);
    try {
      await AuthnWebauthnCredential.insert({
        id_hash: sha256hex(row.credentialId),
        credential_id: row.credentialId,
        identity,
        public_key: Buffer.from(row.publicKey).toString('base64url'),
        counter: row.counter,
        transports: row.transports ? JSON.stringify(row.transports) : null,
        aaguid: row.aaguid ?? null,
        name: row.name ?? null,
        created_at: utc(row.createdAt, 'createdAt'),
      });
    } catch (err) {
      if (err instanceof UniqueViolation) throw new WebAuthnCredentialExists('the WebAuthn credential is registered already');
      throw err;
    }
  }

  async get(credentialId: string): Promise<WebAuthnCredential | null> {
    if (typeof credentialId !== 'string' || credentialId === '') return null;
    const rows = await AuthnWebauthnCredential.query().columns(COLUMNS).where('id_hash', sha256hex(credentialId));
    const r = rows.find((x) => x.credential_id === credentialId);
    return r ? credentialOf(r) : null;
  }

  async listFor(id: IdentityRef): Promise<readonly WebAuthnCredential[]> {
    const identity = identityKey(id);
    const rows = await AuthnWebauthnCredential.query().columns(COLUMNS).where('identity', identity).orderBy('created_at').orderBy('id_hash');
    return rows.filter((r) => r.identity === identity).map(credentialOf);
  }

  async advance(credentialId: string, expected: number, next: number, at: Date): Promise<boolean> {
    checkedCredentialId(credentialId);
    checkedCounter(expected, 'expected');
    checkedCounter(next, 'next');
    const when = utc(at, 'DbWebAuthnCredentialStore.advance: at');
    return (await AuthnWebauthnCredential.update({ counter: next, last_used_at: when }).where('id_hash', sha256hex(credentialId)).where('counter', expected)).RowsAffected === 1;
  }

  async remove(id: IdentityRef, credentialId: string): Promise<boolean> {
    const identity = identityKey(id);
    if (typeof credentialId !== 'string' || credentialId === '') return false;
    return (await AuthnWebauthnCredential.destroy().where('id_hash', sha256hex(credentialId)).where('identity', identity)).RowsAffected === 1;
  }
}

/**
 * `WebAuthnChallengeStore` on `authn_webauthn_challenge`. `take` reads the row and keeps it only if its own delete
 * removed it, so a challenge is taken once across processes. Expired rows are purged in batches as challenges are put.
 */
@PerChildInstance()
@Injectable(WebAuthnChallengeStore)
export class DbWebAuthnChallengeStore extends WebAuthnChallengeStore {
  /** Never read: injecting it resolves the Orm, which binds the models, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  private readonly purgeDue = everyNthCall(PURGE_EVERY);

  async put(c: WebAuthnChallenge, maxRows?: number): Promise<void> {
    const row = checkedChallenge(c);
    if (this.purgeDue()) await this.purge(new Date());
    if (maxRows !== undefined && (await AuthnWebauthnChallenge.count()) >= maxRows) throw new PasskeyChallengesFull();
    await AuthnWebauthnChallenge.insert({
      id: row.id,
      challenge: row.challenge,
      purpose: row.purpose,
      identity: row.identity ? identityKey(row.identity) : null,
      expires_at: utc(row.expiresAt, 'expiresAt'),
    });
  }

  async take(id: string, now: Date): Promise<WebAuthnChallenge | null> {
    if (typeof id !== 'string' || id === '' || id.length > CHALLENGE_ID_MAX) return null;
    const nowMs = utc(now, 'DbWebAuthnChallengeStore.take: now').toMillis();
    const rows = await AuthnWebauthnChallenge.query().columns(['id', 'challenge', 'purpose', 'identity', 'expires_at']).where('id', id);
    const r = rows.find((x) => x.id === id);
    if (!r || (await AuthnWebauthnChallenge.destroy().where('id', id)).RowsAffected !== 1) return null;
    const expiresAt = readInstant(r.expires_at);
    if (!expiresAt || expiresAt.getTime() <= nowMs) return null;
    return { id: r.id, challenge: r.challenge, purpose: r.purpose as WebAuthnCeremony, ...(r.identity ? { identity: parseIdentityKey(r.identity) } : {}), expiresAt };
  }

  /** Deletes up to one batch of expired challenges; returns how many went. */
  async purge(now: Date = new Date()): Promise<number> {
    const t = utc(now, 'DbWebAuthnChallengeStore.purge: now');
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const ids = (await AuthnWebauthnChallenge.query().columns(['id']).where('expires_at', '<=', t).orderBy('id').take(PURGE_BATCH)).map((r) => r.id);
    if (ids.length === 0) return 0;
    return (await AuthnWebauthnChallenge.destroy().whereIn('id', ids).where('expires_at', '<=', t)).RowsAffected;
  }
}

/** `WebAuthnRecoveryCodeStore` on authn-orm's `authn_recovery_code`, through its `DbMfaStore`. */
@PerChildInstance()
@Injectable(WebAuthnRecoveryCodeStore)
export class DbWebAuthnRecoveryCodeStore extends WebAuthnRecoveryCodeStore {
  @Autoinject(DbMfaStore)
  protected DbMfaStore: DbMfaStore;

  /** DI passes nothing and injects `DbMfaStore`. */
  constructor(private readonly db?: DbMfaStore) {
    super();
  }

  private store(): DbMfaStore {
    return this.db ?? this.DbMfaStore;
  }

  replace(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    return this.store().replaceRecoveryCodes(id, rawCodes);
  }

  redeem(id: IdentityRef, raw: string): Promise<boolean> {
    return this.store().redeemRecoveryCode(id, raw);
  }

  remove(id: IdentityRef): Promise<void> {
    return this.store().removeRecoveryCodes(id);
  }
}
