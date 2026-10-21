import type { IdentityRef } from '@spinajs/authn/contracts';
import { SoftAuthenticator } from '@spinajs/authn-testing';

import type { WebAuthnOptions } from '../../src/options.js';

export const RP_ID = 'app.example.test';
export const ORIGIN = 'https://app.example.test';
export const EVIL_ORIGIN = 'https://evil.example.net';

export const ALICE: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
export const BOB: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000002' };

export const START = new Date('2026-10-21T10:00:00Z');

export const OPTIONS: WebAuthnOptions = Object.freeze({ rpId: RP_ID, rpName: 'Kit App', origins: [ORIGIN], userVerification: 'preferred', challengeTtlSeconds: 300, recoveryCodes: 10 });

export const webauthnOptions = (over: Partial<WebAuthnOptions> = {}): WebAuthnOptions => Object.freeze({ ...OPTIONS, ...over });

/** A fixed challenge, so the assertions signed over it are the same bytes on every run. */
export const FIXED_CHALLENGE = Buffer.from('kit-webauthn-fixed-challenge-0001').toString('base64url');

/** The authenticator of `seed`: the same key and credential id on every run. */
export const authenticator = (seed = 'alice', over: { uv?: boolean; counter?: number } = {}): SoftAuthenticator => new SoftAuthenticator({ seed, ...over });

/** `{ challengeId, options }` as the step and the service hand them out. */
export function ceremonyOf(json: string): { challengeId: string; options: any } {
  const parsed = JSON.parse(json) as { challengeId: string; options: any };
  if (typeof parsed.challengeId !== 'string' || typeof parsed.options?.challenge !== 'string') throw new Error(`not a WebAuthn ceremony: ${json}`);
  return parsed;
}
