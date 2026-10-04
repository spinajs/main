import { createPublicKey } from 'node:crypto';
import type { JsonWebKey as NodeJwk } from 'node:crypto';
import { importJWK } from 'jose';
import type { JWK } from 'jose';

import { OIDC_SIGNING_ALGORITHMS } from './contracts.js';
import type { OidcSigningAlgorithm } from './contracts.js';
import type { OidcHttpClient } from './http/client.js';
import { checkedUrl, isPlainObject } from './support.js';

export const JWKS_MAX_AGE_MS = 3_600_000;
/** Design §22.9 / A16: an unknown kid refreshes the set at most once a minute; a failed fetch waits as long. */
export const JWKS_REFRESH_MS = 60_000;
const MIN_RSA_BITS = 2048;
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
const CURVES: Readonly<Record<string, { kty: string; crv: string }>> = {
  ES256: { kty: 'EC', crv: 'P-256' },
  ES384: { kty: 'EC', crv: 'P-384' },
  ES512: { kty: 'EC', crv: 'P-521' },
  EdDSA: { kty: 'OKP', crv: 'Ed25519' },
};

interface Entry {
  readonly kid?: string;
  /** Null when the published key is refused: a kid naming it must fail without a refresh. */
  readonly jwk: JWK | null;
  readonly alg?: string;
}

export type JwksUriSource = string | ((now: number) => Promise<string>);

const isAlgorithm = (alg: unknown): alg is OidcSigningAlgorithm => typeof alg === 'string' && (OIDC_SIGNING_ALGORITHMS as readonly string[]).includes(alg);

/** Only the public members jose needs, so `use`, `key_ops` or a stray member never change how it imports. */
function publicJwkOf(k: Record<string, unknown>): JWK | null {
  if (PRIVATE_MEMBERS.some((m) => m in k)) return null;
  if (k.use !== undefined && k.use !== 'sig') return null;
  const ops = k.key_ops;
  if (ops !== undefined && !(Array.isArray(ops) && ops.length === 1 && ops[0] === 'verify')) return null;
  let jwk: JWK;
  if (k.kty === 'RSA') jwk = { kty: 'RSA', n: k.n as string, e: k.e as string };
  else if (k.kty === 'EC' && ['P-256', 'P-384', 'P-521'].includes(k.crv as string)) jwk = { kty: 'EC', crv: k.crv as string, x: k.x as string, y: k.y as string };
  else if (k.kty === 'OKP' && k.crv === 'Ed25519') jwk = { kty: 'OKP', crv: 'Ed25519', x: k.x as string };
  else return null;
  try {
    const details = createPublicKey({ key: jwk as NodeJwk, format: 'jwk' }).asymmetricKeyDetails;
    if (jwk.kty === 'RSA' && !((details?.modulusLength ?? 0) >= MIN_RSA_BITS)) return null;
  } catch {
    return null;
  }
  return jwk;
}

function fits(e: Entry, alg: OidcSigningAlgorithm): boolean {
  if (!e.jwk || (e.alg !== undefined && e.alg !== alg)) return false;
  if (alg.startsWith('RS') || alg.startsWith('PS')) return e.jwk.kty === 'RSA';
  const want = CURVES[alg];
  return e.jwk.kty === want.kty && e.jwk.crv === want.crv;
}

/** The JWKS of one provider (D9): kept an hour; an unknown kid, or no key fitting the alg, refreshes at most once a minute. */
export class OidcJwks {
  protected entries: readonly Entry[] | undefined;
  protected fetchedAt = 0;
  protected attemptedAt = Number.NEGATIVE_INFINITY;
  protected inflight: Promise<void> | undefined;
  protected readonly imported = new Map<string, Promise<CryptoKey>>();

  /** @param relaxed - an http JWKS URI allowed (development and test) */
  constructor(
    protected readonly uri: JwksUriSource,
    protected readonly http: OidcHttpClient,
    protected readonly relaxed: boolean,
  ) {}

  /** The verification key for a JWS header; throws when none fits. */
  public async key(header: { readonly alg: string; readonly kid?: string }, now: number = Date.now()): Promise<CryptoKey> {
    const alg = header.alg;
    if (!isAlgorithm(alg)) {
      throw new Error('authn-oidc: the token algorithm is not allowed');
    }
    if (!Number.isFinite(now)) {
      throw new Error('authn-oidc: the JWKS needs a finite time');
    }
    if (header.kid !== undefined && typeof header.kid !== 'string') {
      throw new Error('authn-oidc: the token kid is not a string');
    }
    const kid = header.kid;

    await this.load(now, now >= this.fetchedAt + JWKS_MAX_AGE_MS);
    let found = this.find(alg, kid);
    if (found === 'missing') {
      await this.load(now, true);
      found = this.find(alg, kid);
    }
    if (found === 'missing' || found === 'refused') {
      throw new Error('authn-oidc: no key of the provider fits the token');
    }
    const index = this.entries!.indexOf(found);
    const cacheKey = `${index}|${alg}`;
    let key = this.imported.get(cacheKey);
    if (!key) {
      const importing = importJWK(found.jwk!, alg) as Promise<CryptoKey>;
      key = importing;
      this.imported.set(cacheKey, importing);
      importing.catch(() => {
        if (this.imported.get(cacheKey) === importing) this.imported.delete(cacheKey);
      });
    }
    return key;
  }

  protected find(alg: OidcSigningAlgorithm, kid: string | undefined): Entry | 'missing' | 'refused' {
    const entries = this.entries ?? [];
    if (kid !== undefined) {
      const named = entries.filter((e) => e.kid === kid);
      if (named.length === 0) return 'missing';
      const usable = named.filter((e) => fits(e, alg));
      return usable.length === 1 ? usable[0] : 'refused';
    }
    const usable = entries.filter((e) => fits(e, alg));
    if (usable.length === 0) return 'missing';
    return usable.length === 1 ? usable[0] : 'refused';
  }

  /** Fetches when `wanted` and the once-a-minute limit allows; concurrent callers share one fetch. */
  protected async load(now: number, wanted: boolean): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    if (!wanted && this.entries) return;
    if (now < this.attemptedAt + JWKS_REFRESH_MS) {
      if (this.entries) return;
      throw new Error('authn-oidc: the JWKS fetch failed recently');
    }
    this.attemptedAt = now;
    this.inflight = this.fetch(now).then(
      (entries) => {
        this.entries = entries;
        this.fetchedAt = now;
        this.imported.clear();
      },
      (err: unknown) => {
        if (!this.entries) throw err;
      },
    );
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  protected async fetch(now: number): Promise<readonly Entry[]> {
    const uri = typeof this.uri === 'string' ? this.uri : await this.uri(now);
    if (!checkedUrl(uri, { relaxed: this.relaxed, query: true })) {
      throw new Error(`authn-oidc: the JWKS URI must be an absolute ${this.relaxed ? 'http or https' : 'https'} URL`);
    }
    const { status, json } = await this.http.getJson(uri);
    if (status !== 200 || !isPlainObject(json) || !Array.isArray(json.keys)) {
      throw new Error(`authn-oidc: the JWKS answered HTTP ${status} without a key set`);
    }
    const entries: Entry[] = [];
    for (const k of json.keys) {
      if (!isPlainObject(k)) continue;
      const kid = typeof k.kid === 'string' ? k.kid : undefined;
      const jwk = publicJwkOf(k);
      if (!jwk && kid === undefined) continue;
      entries.push({ ...(kid !== undefined ? { kid } : {}), jwk, ...(k.alg !== undefined ? { alg: String(k.alg) } : {}) });
    }
    return Object.freeze(entries);
  }
}
