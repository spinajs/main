import type { AuthenticationResponseJSON, VerifiedAuthenticationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';

/** The assertion check of `@simplewebauthn/server`; a seam for tests that count calls. */
export type AssertionVerifier = typeof verifyAuthenticationResponse;

export type { AuthenticationResponseJSON, VerifiedAuthenticationResponse };
