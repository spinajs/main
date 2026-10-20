import type { KeyAlgorithm, KeyMaterial } from './keys.js';

/** Canvas C8 D4 codes in check order; a verification reports the first check that fails. */
export type JwsErrorCode = 'malformed' | 'bad_header' | 'unknown_key' | 'bad_signature' | 'invalid_claims' | 'wrong_issuer' | 'wrong_audience' | 'expired' | 'not_yet_valid';

/** Exactly these members, written in this order. */
export interface JwsHeader {
  readonly alg: KeyAlgorithm;
  readonly kid: string;
  readonly typ: string;
}

/** iat and exp are integer Unix seconds. */
export interface JwsClaims {
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

/** A KeyRecord is one. */
export type JwsKey = KeyMaterial & { readonly kid: string };

export interface JwsVerifyOptions<C extends JwsClaims, K extends JwsKey = JwsKey> {
  /** Exact match: 'canvas-rt+jwt', 'spinajs-client+jwt'. */
  readonly typ: string;
  /** A header alg outside this list is bad_header. */
  readonly algorithms: readonly KeyAlgorithm[];
  /** Usable keys only (not revoked, not expired); null is unknown_key, and so is a key whose alg differs from the header's. */
  readonly keys: (kid: string) => Promise<K | null>;
  /** The payload rules beyond iss, aud, iat and exp; null is invalid_claims. */
  readonly claims: (payload: Readonly<Record<string, unknown>>) => C | null;
  /** A function when the issuer depends on the key, e.g. an assertion's iss is the key owner. */
  readonly issuer: string | ((iss: string, key: K) => boolean);
  readonly audience: string;
  /** In whole seconds: expired when now ≥ exp + skewSeconds, not_yet_valid when iat > now + skewSeconds. */
  readonly now: Date;
  readonly skewSeconds: number;
  /** exp − iat above this is invalid_claims, as is exp ≤ iat. */
  readonly maxLifetimeSeconds: number;
}

export type JwsVerification<C extends JwsClaims, K extends JwsKey = JwsKey> = { readonly ok: true; readonly header: JwsHeader; readonly claims: C; readonly key: K } | { readonly ok: false; readonly code: JwsErrorCode };

/** Implemented by @spinajs/authn-keys: compact JWS under the canvas C8 rules (A17). */
export abstract class JwsVerifier {
  /**
   * malformed: not three strict base64url parts, or a signature that is not 64 bytes; bad_header: not exactly { alg, kid, typ } with an
   * allowed alg and the expected typ; then unknown_key, bad_signature (checked with the key's own algorithm, never the header's),
   * invalid_claims, wrong_issuer, wrong_audience, expired, not_yet_valid. Bad tokens yield a code; they are never thrown (A17).
   */
  abstract verify<C extends JwsClaims, K extends JwsKey = JwsKey>(token: string, opts: JwsVerifyOptions<C, K>): Promise<JwsVerification<C, K>>;
}

export interface JwsSignOptions {
  readonly typ: string;
  /** One of the signer's own keys; default: its current one. */
  readonly kid?: string;
}

/** Holds its private keys (from a secret reference, or in a KMS); callers never pass or see them. */
export abstract class JwsSigner {
  /**
   * Header { alg, kid, typ } in that order, alg from the key; the claims as JSON.stringify writes them, in the caller's key order.
   * EdDSA is deterministic, so the C8 golden tickets come out byte for byte. Throws for a kid it does not hold: a configuration error.
   */
  abstract sign<C extends JwsClaims>(claims: C, opts: JwsSignOptions): Promise<string>;
  /** For a JWKS route (C8 D5) and the verifiers' key lookup. */
  abstract publicKeys(): Promise<readonly JwsKey[]>;
}
