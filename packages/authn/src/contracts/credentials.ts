import type { AuthnFacts, Ceiling } from './principal.js';
import type { SessionHandle } from './session.js';

/** Raw credentials as extracted from a request or passed by code. */
export type Credentials =
  | { readonly kind: 'password'; readonly login: string; readonly password: string }
  /** spt_… API token or a JWT. */
  | { readonly kind: 'bearer'; readonly token: string }
  /** Client assertion signed by a registered key. */
  | { readonly kind: 'jws-assertion'; readonly jws: string }
  /** RFC 9421 subset. */
  | { readonly kind: 'http-signature'; readonly request: SignedRequest }
  | { readonly kind: 'key-challenge'; readonly keyId: string; readonly challengeId: string; readonly signature: string }
  /** OIDC code, SAML response, LDAP bind. */
  | { readonly kind: 'external'; readonly provider: string; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly kind: string; readonly [k: string]: unknown };

export interface SignedRequest {
  readonly method: string;
  readonly targetUri: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

/** Facts about the attempt, filled by authn-http or the caller. */
export interface AuthnContext {
  /** From the trusted-proxy chain only (A05). */
  readonly ip?: string;
  readonly userAgent?: string;
  readonly now: Date;
  /** Present when completing MFA or re-authenticating. */
  readonly session?: SessionHandle;
  readonly purpose: 'login' | 'request' | 'reauth' | 'link';
}

export interface IdentityRef {
  readonly type: 'user' | 'service' | (string & {});
  /** users.Uuid for users. */
  readonly id: string;
}

export interface ExternalSubject {
  readonly provider: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly claims?: Readonly<Record<string, unknown>>;
}

/** Bad credentials yield a failure result; they are never thrown. */
export type AuthenticationResult =
  | {
      readonly status: 'success';
      readonly identity: IdentityRef;
      readonly facts: Omit<AuthnFacts, 'authenticatedAt'>;
      /** Token or key scope. */
      readonly ceiling?: Ceiling;
      /** Agent tokens. */
      readonly delegation?: { readonly onBehalfOf: IdentityRef; readonly mode: 'inherit' | 'intersect' };
      /** Set when an interactive login issued one. */
      readonly session?: SessionHandle;
      /** From StrategyOutcome.attributes; principalOf merges them into Principal.attributes. */
      readonly attributes?: Readonly<Record<string, unknown>>;
    }
  | { readonly status: 'mfa_required'; readonly pending: SessionHandle; readonly steps: readonly string[] }
  | {
      readonly status: 'failure';
      readonly reason: AuthnFailure;
      /** Set only when reason is 'throttled'; the HTTP layer sends it as Retry-After (A02, A06). */
      readonly retryAfterSeconds?: number;
    };

/** Goes to audit only; HTTP answers one shape for all of them (A02). */
export type AuthnFailure = 'invalid_credentials' | 'throttled' | 'unsupported_credentials' | 'expired' | 'revoked' | 'not_linked';

export type StrategyOutcome =
  | {
      readonly ok: true;
      /** One of identity and external. */
      readonly identity?: IdentityRef;
      readonly external?: ExternalSubject;
      readonly method: string;
      readonly ceiling?: Ceiling;
      readonly delegation?: { readonly onBehalfOf: IdentityRef; readonly mode: 'inherit' | 'intersect' };
      /** Merged into Principal.attributes. Adds attributes only, never authority; a token's Profile travels as attributes.profile (§18.3(e)). */
      readonly attributes?: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly reason: AuthnFailure };
