import type { OidcAuthorizationParams } from '../contracts.js';
import type { OidcFlowSecrets } from './cookie.js';

export interface AuthorizationRequest {
  readonly endpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly secrets: OidcFlowSecrets;
  /** False for plain OAuth2, which has no ID token to carry a nonce. */
  readonly nonce: boolean;
  readonly extra: OidcAuthorizationParams;
}

/** The authorization code request with PKCE S256 (RFC 6749 §4.1.1, RFC 7636 §4.3); never an implicit or hybrid flow. */
export function authorizationUrl(r: AuthorizationRequest): string {
  const url = new URL(r.endpoint);
  for (const [k, v] of Object.entries(r.extra)) {
    url.searchParams.set(k, v as string);
  }
  // Set after the extras, so the flow's own parameters always win (the config reader refuses reserved extras too).
  const own: Record<string, string> = {
    response_type: 'code',
    client_id: r.clientId,
    redirect_uri: r.redirectUri,
    scope: r.scopes.join(' '),
    state: r.secrets.state,
    code_challenge: r.secrets.codeChallenge,
    code_challenge_method: 'S256',
    ...(r.nonce ? { nonce: r.secrets.nonce } : {}),
  };
  for (const [k, v] of Object.entries(own)) {
    url.searchParams.set(k, v);
  }
  for (const k of ['response_mode', 'request', 'request_uri', 'max_age', 'acr_values', ...(r.nonce ? [] : ['nonce'])]) {
    url.searchParams.delete(k);
  }
  return url.toString();
}
