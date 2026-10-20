import { createHash, createHmac, createPublicKey, randomBytes } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';
import { OidcHttpClient } from '../../src/http/client.js';
import type { OidcHttpHeaders, OidcHttpResponse } from '../../src/http/client.js';

export interface FakeRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: OidcHttpHeaders;
  readonly form?: Readonly<Record<string, string>>;
}

/** An Error is thrown to the caller, as a transport failure would be. */
export type FakeAnswer = OidcHttpResponse | Error;
export type FakeHandler = (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;

export type FakeKeyAlgorithm = 'RS256' | 'EdDSA';

export interface FakeIdpKey {
  readonly alg: FakeKeyAlgorithm;
  readonly kid: string;
  /** As published in the JWKS (kid, alg and use included). */
  readonly publicJwk: JWK;
  readonly privateKey: CryptoKey;
}

export const FAKE_ISSUER = 'https://idp.example.test/realms/corp';
export const FAKE_CLIENT_ID = 'canvas';
export const FAKE_CLIENT_SECRET = 'fake-client-secret-0123456789';

/** The kit's ID token tampers (IdTokenTamper of @spinajs/authn-testing) plus 'none'. */
export type FakeTamper = 'none' | 'wrong-iss' | 'wrong-aud' | 'azp-mismatch' | 'wrong-nonce' | 'expired' | 'iat-future' | 'alg-none' | 'hmac-public-key' | 'at-hash-mismatch';

export interface FakeLogin {
  /** ID token and userinfo claims; `sub` at least (GitHub: `id`). */
  readonly claims: Readonly<Record<string, unknown>>;
  /** Claims only userinfo answers (merged over `claims`). */
  readonly userinfo?: Readonly<Record<string, unknown>>;
  readonly tamper?: FakeTamper;
  /** Signing key; default the first. */
  readonly key?: FakeIdpKey;
  /** Merged into the ID token claims after the tamper. */
  readonly override?: Readonly<Record<string, unknown>>;
}

interface IssuedCode {
  readonly login: FakeLogin;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string | null;
  readonly codeChallengeMethod: string | null;
  readonly nonce: string | null;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function atHash(accessToken: string, alg: FakeKeyAlgorithm): string {
  const digest = createHash(alg === 'EdDSA' ? 'sha512' : 'sha256').update(accessToken, 'ascii').digest();
  return digest.subarray(0, digest.length / 2).toString('base64url');
}

/**
 * An in-memory identity provider behind the OidcHttpClient port: serves discovery, JWKS, token and userinfo from
 * memory, plays the authorization endpoint (authorize), records every request, and lets a test override, fail or hold
 * any URL.
 */
export class FakeIdp extends OidcHttpClient {
  public readonly requests: FakeRequest[] = [];
  public readonly keys: FakeIdpKey[] = [];
  /** Served at discoveryUrl; tests change members freely. */
  public discovery: Record<string, unknown>;
  /** null: the JWKS is built from `keys`. */
  public jwks: Record<string, unknown> | null = null;
  public clientId = FAKE_CLIENT_ID;
  public clientSecret = FAKE_CLIENT_SECRET;
  /** Plain OAuth2 (GitHub): the token answer has no ID token. */
  public idTokens = true;
  public readonly codes = new Map<string, IssuedCode>();
  public readonly accessTokens = new Map<string, Readonly<Record<string, unknown>>>();

  protected readonly routes = new Map<string, FakeHandler>();
  protected readonly gates = new Map<string, Promise<void>>();

  constructor(public readonly issuer: string = FAKE_ISSUER) {
    super();
    const base = issuer.replace(/\/$/, '');
    this.discovery = {
      issuer,
      authorization_endpoint: `${base}/protocol/openid-connect/auth`,
      token_endpoint: `${base}/protocol/openid-connect/token`,
      userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`,
      jwks_uri: `${base}/protocol/openid-connect/certs`,
      response_types_supported: ['code', 'id_token', 'code id_token'],
      code_challenge_methods_supported: ['plain', 'S256'],
      id_token_signing_alg_values_supported: ['RS256', 'EdDSA'],
    };
  }

  static async create(issuer: string = FAKE_ISSUER, algorithms: readonly FakeKeyAlgorithm[] = ['RS256', 'EdDSA']): Promise<FakeIdp> {
    const idp = new FakeIdp(issuer);
    for (const alg of algorithms) {
      await idp.addKey(alg);
    }
    return idp;
  }

  get discoveryUrl(): string {
    return `${this.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  }

  get jwksUri(): string {
    return this.discovery.jwks_uri as string;
  }

  get tokenUrl(): string {
    return this.discovery.token_endpoint as string;
  }

  get userinfoUrl(): string {
    return this.discovery.userinfo_endpoint as string;
  }

  async addKey(alg: FakeKeyAlgorithm, kid: string = `${alg.toLowerCase()}-${this.keys.length + 1}`): Promise<FakeIdpKey> {
    const pair = await generateKeyPair(alg, { extractable: true });
    const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid, alg, use: 'sig' };
    const key: FakeIdpKey = { alg, kid, publicJwk, privateKey: pair.privateKey };
    this.keys.push(key);
    return key;
  }

  /** A compact JWS over `payload` with the key's alg and kid (override the header members with `header`). */
  async sign(key: FakeIdpKey, payload: string, header: Record<string, unknown> = {}): Promise<string> {
    return new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({ alg: key.alg, kid: key.kid, ...header }).sign(key.privateKey);
  }

  /**
   * Plays the authorization endpoint for the request URL `location`: checks it is a code request for this client,
   * remembers the login, and returns the callback query (code and state, plus iss when `withIss`).
   */
  authorize(location: string, login: FakeLogin, opts: { withIss?: boolean; authorizationEndpoint?: string } = {}): Record<string, string> {
    const u = new URL(location);
    const q = u.searchParams;
    const endpoint = new URL(opts.authorizationEndpoint ?? String(this.discovery.authorization_endpoint));
    if (u.origin + u.pathname !== endpoint.origin + endpoint.pathname) {
      throw new Error(`fake IdP: not my authorization endpoint: ${u.origin}${u.pathname}`);
    }
    if (q.get('response_type') !== 'code' || q.get('client_id') !== this.clientId || !q.get('redirect_uri') || !q.get('state')) {
      throw new Error('fake IdP: not a code request for my client');
    }
    const code = b64url(randomBytes(24));
    this.codes.set(code, {
      login,
      clientId: q.get('client_id')!,
      redirectUri: q.get('redirect_uri')!,
      codeChallenge: q.get('code_challenge'),
      codeChallengeMethod: q.get('code_challenge_method'),
      nonce: q.get('nonce'),
    });
    return { code, state: q.get('state')!, ...(opts.withIss ? { iss: this.issuer } : {}) };
  }

  /** An ID token for an issued code, with the login's tamper applied. */
  async idToken(issued: { readonly login: FakeLogin; readonly nonce: string | null }, accessToken: string): Promise<string> {
    const login = issued.login;
    const key = login.key ?? this.keys[0];
    const now = Math.floor(Date.now() / 1000);
    const tamper = login.tamper ?? 'none';
    let claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.clientId,
      iat: now,
      exp: now + 300,
      ...(issued.nonce !== null ? { nonce: issued.nonce } : {}),
      at_hash: atHash(accessToken, key.alg),
      ...login.claims,
    };
    if (tamper === 'wrong-iss') claims.iss = 'https://evil.example.test/realms/corp';
    if (tamper === 'wrong-aud') claims.aud = 'another-client';
    if (tamper === 'azp-mismatch') Object.assign(claims, { aud: [this.clientId, 'another-client'], azp: 'another-client' });
    if (tamper === 'wrong-nonce') claims.nonce = b64url(randomBytes(32));
    if (tamper === 'expired') Object.assign(claims, { iat: now - 7200, exp: now - 3600 });
    if (tamper === 'iat-future') Object.assign(claims, { iat: now + 3600, exp: now + 7200 });
    if (tamper === 'at-hash-mismatch') claims.at_hash = atHash(b64url(randomBytes(32)), key.alg);
    claims = { ...claims, ...login.override };
    const payload = JSON.stringify(claims);
    if (tamper === 'alg-none') {
      return `${b64url(JSON.stringify({ alg: 'none', kid: key.kid }))}.${b64url(payload)}.`;
    }
    if (tamper === 'hmac-public-key') {
      // The classic key confusion: HS256 keyed with the published public key, which anyone can compute.
      const rsa = this.keys.find((k) => k.alg === 'RS256') ?? key;
      const pem = createPublicKey({ key: rsa.publicJwk as never, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
      const input = `${b64url(JSON.stringify({ alg: 'HS256', kid: rsa.kid }))}.${b64url(payload)}`;
      return `${input}.${createHmac('sha256', pem).update(input).digest('base64url')}`;
    }
    return this.sign(key, payload);
  }

  /** Answers `url` with `handler` instead of the default. */
  on(url: string, handler: FakeHandler): this {
    this.routes.set(url, handler);
    return this;
  }

  /** Every request to `url` fails until `restore(url)`. */
  fail(url: string, answer: FakeAnswer = new Error('connection refused')): this {
    return this.on(url, () => answer);
  }

  restore(url: string): this {
    this.routes.delete(url);
    return this;
  }

  /** Requests to `url` wait until the returned release is called. */
  hold(url: string): () => void {
    let release: () => void = () => undefined;
    this.gates.set(
      url,
      new Promise<void>((resolve) => {
        release = () => {
          this.gates.delete(url);
          resolve();
        };
      }),
    );
    return release;
  }

  count(url: string): number {
    return this.requests.filter((r) => r.url === url).length;
  }

  async getJson(url: string, headers: OidcHttpHeaders = {}): Promise<OidcHttpResponse> {
    return this.answer({ method: 'GET', url, headers });
  }

  async postForm(url: string, form: Readonly<Record<string, string>>, headers: OidcHttpHeaders = {}): Promise<OidcHttpResponse> {
    return this.answer({ method: 'POST', url, headers, form });
  }

  protected async answer(req: FakeRequest): Promise<OidcHttpResponse> {
    this.requests.push(req);
    const gate = this.gates.get(req.url);
    if (gate) {
      await gate;
    }
    const answer = await (this.routes.get(req.url) ?? ((r: FakeRequest) => this.defaultAnswer(r)))(req);
    if (answer instanceof Error) {
      throw answer;
    }
    // A copy, so the code under test cannot change the fake's state.
    return { status: answer.status, json: structuredClone(answer.json) };
  }

  /** The client id and secret of a token request, from Basic auth (form-urlencoded parts) or the form. */
  protected clientOf(req: FakeRequest): { id: string; secret: string } | null {
    const basic = req.headers.authorization;
    if (basic?.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const part = (s: string) => new URLSearchParams(`v=${s}`).get('v') ?? '';
      return { id: part(decoded.slice(0, i)), secret: part(decoded.slice(i + 1)) };
    }
    if (req.form?.client_id !== undefined) {
      return { id: req.form.client_id, secret: req.form.client_secret ?? '' };
    }
    return null;
  }

  protected async tokenAnswer(req: FakeRequest): Promise<FakeAnswer> {
    const form = req.form ?? {};
    const client = this.clientOf(req);
    if (!client || client.id !== this.clientId || client.secret !== this.clientSecret) {
      return { status: 401, json: { error: 'invalid_client' } };
    }
    const issued = this.codes.get(form.code ?? '');
    this.codes.delete(form.code ?? '');
    if (form.grant_type !== 'authorization_code' || !issued || issued.clientId !== client.id || issued.redirectUri !== form.redirect_uri) {
      return { status: 400, json: { error: 'invalid_grant' } };
    }
    if (issued.codeChallenge !== null) {
      const challenge = createHash('sha256').update(form.code_verifier ?? '', 'ascii').digest('base64url');
      if (issued.codeChallengeMethod !== 'S256' || challenge !== issued.codeChallenge) {
        return { status: 400, json: { error: 'invalid_grant', error_description: 'PKCE' } };
      }
    }
    const accessToken = b64url(randomBytes(32));
    this.accessTokens.set(accessToken, { ...issued.login.claims, ...issued.login.userinfo });
    const answer: Record<string, unknown> = { access_token: accessToken, token_type: 'Bearer', expires_in: 300 };
    if (this.idTokens) {
      answer.id_token = await this.idToken(issued, accessToken);
    }
    return { status: 200, json: answer };
  }

  protected userinfoAnswer(req: FakeRequest): FakeAnswer {
    const auth = req.headers.authorization ?? '';
    const claims = auth.startsWith('Bearer ') ? this.accessTokens.get(auth.slice(7)) : undefined;
    return claims ? { status: 200, json: claims } : { status: 401, json: { error: 'invalid_token' } };
  }

  protected defaultAnswer(req: FakeRequest): FakeAnswer | Promise<FakeAnswer> {
    if (req.method === 'GET' && req.url === this.discoveryUrl) {
      return { status: 200, json: this.discovery };
    }
    if (req.method === 'GET' && req.url === this.jwksUri) {
      return { status: 200, json: this.jwks ?? { keys: this.keys.map((k) => k.publicJwk) } };
    }
    if (req.method === 'POST' && req.url === this.tokenUrl) {
      return this.tokenAnswer(req);
    }
    if (req.method === 'GET' && req.url === this.userinfoUrl) {
      return this.userinfoAnswer(req);
    }
    return { status: 404, json: { error: 'not_found' } };
  }
}
