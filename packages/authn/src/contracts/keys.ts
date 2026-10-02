import type { AuthnContext, IdentityRef } from './credentials.js';
import type { Ceiling, PrincipalRef } from './principal.js';

/** Fixed on the key record by its key type; never read from a token header (A17). */
export type KeyAlgorithm = 'EdDSA' | 'ES256';

/** RFC 8037. */
export interface Ed25519PublicJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly d?: never;
}

export interface P256PublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly d?: never;
}

/** Public keys only: a JWK with a private part is refused. */
export type PublicJwk = Ed25519PublicJwk | P256PublicJwk;

export type KeyMaterial = { readonly alg: 'EdDSA'; readonly jwk: Ed25519PublicJwk } | { readonly alg: 'ES256'; readonly jwk: P256PublicJwk };

export interface KeyOwner extends IdentityRef {
  readonly type: 'user' | 'service' | 'agent';
}

/** A row of authn_key. */
export type KeyRecord = KeyMaterial & {
  /** 1–64 of [A-Za-z0-9._-]; unique. */
  readonly kid: string;
  readonly owner: KeyOwner;
  /** RFC 7638, base64url; unique. */
  readonly thumbprint: string;
  readonly name?: string;
  readonly scope?: Ceiling;
  readonly createdAt: Date;
  readonly createdBy?: PrincipalRef;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly lastUsedAt?: Date;
};

export interface NewKey {
  /** Default: the thumbprint. */
  readonly kid?: string;
  readonly jwk: PublicJwk;
  readonly name?: string;
  readonly scope?: Ceiling;
  readonly expiresAt?: Date;
}

/** The new key's signature over a 'register' challenge issued to the same user (proof of possession). */
export interface KeyProof {
  readonly challengeId: string;
  /** base64url. */
  readonly signature: string;
}

/** A user's key always needs a proof; services and agents are registered without one by an admin route or the CLI, named as `actor`. */
export type KeyRegistration = (NewKey & { readonly owner: KeyOwner & { readonly type: 'user' }; readonly proof: KeyProof }) | (NewKey & { readonly owner: KeyOwner & { readonly type: 'service' | 'agent' }; readonly actor: PrincipalRef });

export type KeyRegisterResult = { readonly ok: true; readonly key: KeyRecord } | { readonly ok: false; readonly code: 'invalid_key' | 'invalid_proof' | 'duplicate' };

export type KeyChallengeRequest = { readonly purpose: 'register'; readonly owner: KeyOwner & { readonly type: 'user' } } | { readonly purpose: 'login'; readonly kid: string };

export interface KeyChallenge {
  /** Names the challenge in a KeyProof or in key-challenge credentials. */
  readonly id: string;
  /** Signed together with the challenge purpose (domain separation), so a login signature never proves a registration. */
  readonly nonce: string;
  readonly expiresAt: Date;
}

export type KeyChallengeResult = { readonly ok: true; readonly challenge: KeyChallenge } | { readonly ok: false; readonly retryAfterSeconds: number };

/** Implemented by @spinajs/authn-keys over authn_key: Ed25519 and P-256 public keys only (A17). */
export abstract class KeyRegistry {
  /**
   * POST /user/keys (fresh auth, A13) with a proof; an admin route or authn:key-add for services and agents. Refuses a user's key without
   * a valid proof, whatever the caller. Checks the key, then the proof, then that kid and thumbprint are unused.
   */
  abstract register(reg: KeyRegistration, ctx: AuthnContext): Promise<KeyRegisterResult>;
  /** GET /user/keys; revoked and expired keys included. */
  abstract list(owner: IdentityRef): Promise<readonly KeyRecord[]>;
  /**
   * DELETE /user/keys/:kid. Owner-bound: false unless the key's owner has the same type and id as `owner` (no IDOR); an admin route
   * or the CLI passes the key's owner. A revoked key fails on the next request (A17).
   */
  abstract revoke(owner: IdentityRef, kid: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean>;
  /** For verifiers. Returns revoked and expired keys too, so the reason can be audited; accept a key only without revokedAt and before expiresAt. */
  abstract byId(kid: string): Promise<KeyRecord | null>;
  /**
   * POST /auth/keys/challenge (anonymous, login) and the registration proof (an authenticated user).
   * A login challenge first counts against the 'login' flow's IP key; a refusal stores nothing. Every challenge stands alone, stored under its own id (with SecretStore:
   * purpose 'key-challenge:<id>'), so issuing one never cancels another. Single use and short-lived. A login challenge for an unknown kid
   * looks the same and never verifies (A02). A signature covers the purpose too.
   */
  abstract challenge(req: KeyChallengeRequest, ctx: AuthnContext): Promise<KeyChallengeResult>;
}
