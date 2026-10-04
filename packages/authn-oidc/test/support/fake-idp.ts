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

/**
 * An in-memory identity provider behind the OidcHttpClient port: serves discovery and JWKS from memory, records every
 * request, and lets a test override, fail or hold any URL. Later tasks add the token and userinfo endpoints.
 */
export class FakeIdp extends OidcHttpClient {
  public readonly requests: FakeRequest[] = [];
  public readonly keys: FakeIdpKey[] = [];
  /** Served at discoveryUrl; tests change members freely. */
  public discovery: Record<string, unknown>;
  /** null: the JWKS is built from `keys`. */
  public jwks: Record<string, unknown> | null = null;

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

  protected defaultAnswer(req: FakeRequest): FakeAnswer {
    if (req.method === 'GET' && req.url === this.discoveryUrl) {
      return { status: 200, json: this.discovery };
    }
    if (req.method === 'GET' && req.url === this.jwksUri) {
      return { status: 200, json: this.jwks ?? { keys: this.keys.map((k) => k.publicJwk) } };
    }
    return { status: 404, json: { error: 'not_found' } };
  }
}
