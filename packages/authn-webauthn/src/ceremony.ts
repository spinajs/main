import { generateKeyPairSync } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { isPlainObject } from '@spinajs/util';

import type { WebAuthnCredential } from './contracts.js';
import type { WebAuthnChallenge } from './challenge.js';
import type { WebAuthnOptions } from './options.js';
import { CREDENTIAL_ID_MAX } from './store/checks.js';

/** The assertion check of `@simplewebauthn/server`; a seam for tests that count calls. */
export type AssertionVerifier = typeof verifyAuthenticationResponse;

const bytes = (b64url: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(b64url, 'base64url'));

/** The WebAuthn user handle of an identity: the UTF-8 bytes of its id, as base64url. */
export const userHandleOf = (id: IdentityRef): string => Buffer.from(id.id, 'utf8').toString('base64url');

const isB64url = (v: unknown, max = CREDENTIAL_ID_MAX): v is string => typeof v === 'string' && v !== '' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

/** A browser response with the members every ceremony needs; anything else is no response at all. */
function credentialJson(v: unknown): (Record<string, unknown> & { id: string; response: Record<string, unknown> }) | null {
  if (!isPlainObject(v) || !isB64url(v.id) || v.type !== 'public-key' || !isPlainObject(v.response)) return null;
  return v as Record<string, unknown> & { id: string; response: Record<string, unknown> };
}

/** A registration response, or null when it is not one. */
export function registrationJson(v: unknown): RegistrationResponseJSON | null {
  const c = credentialJson(v);
  return c && typeof c.response.clientDataJSON === 'string' && typeof c.response.attestationObject === 'string' ? (c as unknown as RegistrationResponseJSON) : null;
}

/** An assertion response, or null when it is not one. */
export function assertionJson(v: unknown): AuthenticationResponseJSON | null {
  const c = credentialJson(v);
  return c && typeof c.response.clientDataJSON === 'string' && typeof c.response.authenticatorData === 'string' && typeof c.response.signature === 'string' ? (c as unknown as AuthenticationResponseJSON) : null;
}

const descriptors = (existing: readonly WebAuthnCredential[]) => existing.map((c) => ({ id: c.credentialId, ...(c.transports ? { transports: [...c.transports] } : {}) }));

/** Creation options for `challenge`; `discoverable` asks for a passkey, otherwise one is only preferred. */
export function registrationOptions(o: WebAuthnOptions, challenge: WebAuthnChallenge, id: IdentityRef, userName: string, existing: readonly WebAuthnCredential[], discoverable: boolean): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: o.rpName,
    rpID: o.rpId,
    userName,
    userID: bytes(userHandleOf(id)),
    challenge: bytes(challenge.challenge),
    timeout: o.challengeTtlSeconds * 1000,
    attestationType: 'none',
    excludeCredentials: descriptors(existing),
    authenticatorSelection: { residentKey: discoverable ? 'required' : 'preferred', userVerification: o.userVerification },
  });
}

/** Request options for `challenge`; `allowed` empty lets the authenticator offer any discoverable credential. */
export function assertionOptions(o: WebAuthnOptions, challenge: WebAuthnChallenge, allowed: readonly WebAuthnCredential[]): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: o.rpId,
    challenge: bytes(challenge.challenge),
    timeout: o.challengeTtlSeconds * 1000,
    userVerification: o.userVerification,
    ...(allowed.length > 0 ? { allowCredentials: descriptors(allowed) } : {}),
  });
}

/** The credential `response` registers over `challenge`, or null when the attestation does not verify. */
export async function verifiedRegistration(o: WebAuthnOptions, challenge: WebAuthnChallenge, response: RegistrationResponseJSON, identity: IdentityRef, now: Date, name?: string): Promise<WebAuthnCredential | null> {
  try {
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: [...o.origins], expectedRPID: o.rpId, requireUserVerification: o.userVerification === 'required' });
    if (!v.verified || v.registrationInfo.credential.id !== response.id) return null;
    const { credential, aaguid } = v.registrationInfo;
    const transports = Array.isArray(response.response.transports) ? response.response.transports.filter((t): t is NonNullable<typeof t> => typeof t === 'string') : [];
    return {
      credentialId: credential.id,
      identity: { type: identity.type, id: identity.id },
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      ...(transports.length > 0 ? { transports } : {}),
      aaguid,
      ...(name !== undefined ? { name } : {}),
      createdAt: new Date(now.getTime()),
    };
  } catch {
    return null;
  }
}

/** A key no authenticator holds: an assertion for an unknown credential is checked against it, so it costs what a known one does (A02). */
const UNKNOWN = ((): WebAuthnCredential => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  // COSE_Key { 1: 1 (OKP), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: x }
  const cose = Buffer.concat([Buffer.from([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20]), x]);
  return { credentialId: 'unknown', identity: { type: 'user', id: 'unknown' }, publicKey: new Uint8Array(cose), counter: 0, createdAt: new Date(0) };
})();

export interface VerifiedAssertion {
  readonly counter: number;
  readonly userVerified: boolean;
}

/**
 * Checks `response` over `challenge` against `credential` (null: unknown, checked against a key nobody holds and
 * refused). The user handle, when the authenticator sends one, must be the credential owner's.
 */
export async function verifiedAssertion(o: WebAuthnOptions, challenge: WebAuthnChallenge, response: AuthenticationResponseJSON, credential: WebAuthnCredential | null, verifier: AssertionVerifier = verifyAuthenticationResponse): Promise<VerifiedAssertion | null> {
  const against = credential ?? UNKNOWN;
  let result: Awaited<ReturnType<AssertionVerifier>>;
  try {
    result = await verifier({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...o.origins],
      expectedRPID: o.rpId,
      credential: { id: against.credentialId, publicKey: new Uint8Array(against.publicKey), counter: against.counter },
      requireUserVerification: o.userVerification === 'required',
    });
  } catch {
    return null;
  }
  if (!credential || !result.verified) return null;
  const handle = response.response.userHandle;
  if (handle !== undefined && handle !== userHandleOf(credential.identity)) return null;
  return { counter: result.authenticationInfo.newCounter, userVerified: result.authenticationInfo.userVerified };
}
