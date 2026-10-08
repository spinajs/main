import type { OidcTokenEndpointAuth } from '../contracts.js';
import type { OidcHttpClient } from '../http/client.js';
import { isNonEmptyString, isPlainObject } from '../support.js';

export interface CodeExchange {
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly auth: OidcTokenEndpointAuth;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  /** Every provider but plain OAuth2 must answer an ID token. */
  readonly idToken: boolean;
}

export interface OidcTokenSet {
  readonly accessToken: string;
  readonly idToken?: string;
}

const MAX_TOKEN_LENGTH = 16_384;

/** RFC 6749 §2.3.1: id and secret are form-urlencoded before the Basic encoding. */
const formEncode = (s: string): string => new URLSearchParams({ v: s }).toString().slice(2);

/** The authorization code grant (RFC 6749 §4.1.3) with the PKCE verifier; throws on any answer but a valid token set. */
export async function exchangeCode(http: OidcHttpClient, x: CodeExchange): Promise<OidcTokenSet> {
  const form: Record<string, string> = { grant_type: 'authorization_code', code: x.code, redirect_uri: x.redirectUri, code_verifier: x.codeVerifier };
  const headers: Record<string, string> = {};
  if (x.auth === 'client_secret_post') {
    form.client_id = x.clientId;
    form.client_secret = x.clientSecret;
  } else {
    headers.authorization = `Basic ${Buffer.from(`${formEncode(x.clientId)}:${formEncode(x.clientSecret)}`, 'utf8').toString('base64')}`;
  }
  const { status, json } = await http.postForm(x.endpoint, form, headers);
  if (status !== 200 || !isPlainObject(json)) {
    throw new Error(`authn-oidc: the token endpoint answered HTTP ${status}`);
  }
  const { access_token: accessToken, token_type: tokenType, id_token: idToken } = json;
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    throw new Error('authn-oidc: the token endpoint answered no Bearer token');
  }
  if (!isNonEmptyString(accessToken) || accessToken.length > MAX_TOKEN_LENGTH) {
    throw new Error('authn-oidc: the token endpoint answered no access token');
  }
  if (!x.idToken) {
    return { accessToken };
  }
  if (!isNonEmptyString(idToken) || idToken.length > MAX_TOKEN_LENGTH) {
    throw new Error('authn-oidc: the token endpoint answered no ID token');
  }
  return { accessToken, idToken };
}
