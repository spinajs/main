import { timingSafeEqual } from 'node:crypto';

import type { OidcExternalSubject } from './contracts.js';
import type { OidcProviderOptions } from './config/options.js';
import { OidcDiscovery } from './discovery.js';
import type { OidcHttpClient } from './http/client.js';
import { OidcJwks } from './jwks.js';
import { flowIsLive, flowSecrets, newFlow, stateClaim } from './flow/cookie.js';
import type { OidcFlow } from './flow/cookie.js';
import { authorizationUrl } from './flow/authorize.js';
import { exchangeCode } from './token/exchange.js';
import { validateIdToken } from './token/id-token.js';
import { fetchUserinfo } from './token/userinfo.js';
import { hasRequiredClaims, mapClaims, rawClaims } from './claims.js';

/** The single-use store the provider claims states in; NonceStore of @spinajs/authn-orm fits. */
export interface OidcStateStore {
  claim(key: string, expiresAt: Date, now: Date): Promise<boolean>;
}

export interface OidcEndpointSet {
  readonly authorization: string;
  readonly token: string;
  readonly userinfo?: string;
  /** RFC 9207 advertised: the callback must carry iss. */
  readonly issParameter: boolean;
}

export interface OidcCallbackQuery {
  readonly code?: string;
  readonly state?: string;
  readonly iss?: string;
  readonly error?: string;
}

const MAX_CODE_LENGTH = 4096;

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * One configured provider at run time. It keeps one discovery and one JWKS cache for the life of the process, so their
 * refresh limits hold; build it once per provider.
 */
export class OidcProvider {
  public readonly discovery: OidcDiscovery | null;
  public readonly jwks: OidcJwks | null;

  constructor(
    public readonly options: OidcProviderOptions,
    protected readonly http: OidcHttpClient,
    protected readonly states: OidcStateStore,
    relaxed: boolean,
  ) {
    const issuer = options.issuer;
    this.discovery = issuer === null ? null : new OidcDiscovery(issuer, http, relaxed);
    const discovery = this.discovery;
    this.jwks = discovery === null ? null : new OidcJwks((now) => discovery.metadata(now).then((d) => d.jwks_uri), http, relaxed);
  }

  public get name(): string {
    return this.options.name;
  }

  public async endpoints(now: Date): Promise<OidcEndpointSet> {
    if (this.discovery === null) {
      const e = this.options.endpoints!;
      return { authorization: e.authorization, token: e.token, userinfo: e.userinfo, issParameter: false };
    }
    const d = await this.discovery.metadata(now.getTime());
    return {
      authorization: d.authorization_endpoint,
      token: d.token_endpoint,
      ...(d.userinfo_endpoint !== undefined ? { userinfo: d.userinfo_endpoint } : {}),
      issParameter: d.authorization_response_iss_parameter_supported,
    };
  }

  /** A new flow and the authorization request URL for it. */
  public async begin(input: { redirectUri: string; returnTo?: unknown; mode: 'login' | 'link'; sessionHash?: string; now: Date }): Promise<{ flow: OidcFlow; location: string }> {
    const endpoints = await this.endpoints(input.now);
    const flow = newFlow({ provider: this.name, redirectUri: this.options.redirectUri ?? input.redirectUri, returnTo: input.returnTo, mode: input.mode, sessionHash: input.sessionHash, now: input.now });
    const location = authorizationUrl({
      endpoint: endpoints.authorization,
      clientId: this.options.clientId,
      redirectUri: flow.u,
      scopes: this.options.scopes,
      secrets: flowSecrets(flow),
      nonce: this.options.idToken,
      extra: this.options.authorizationParams,
    });
    return { flow, location };
  }

  /**
   * The callback (D1, D2, D10–D13): the flow must be this provider's, live, and match the state; the state is claimed
   * once before any network call; then RFC 9207 iss, the code exchange, the ID token, userinfo and the mapping.
   * Throws on every failure.
   */
  public async complete(flow: OidcFlow, query: OidcCallbackQuery, now: Date): Promise<OidcExternalSubject> {
    const refuse = (what: string): never => {
      throw new Error(`authn-oidc: callback refused: ${what}`);
    };
    if (flow.p !== this.name) refuse('the flow belongs to another provider');
    if (!flowIsLive(flow, now)) refuse('the flow expired');
    const secrets = flowSecrets(flow);
    if (typeof query.state !== 'string' || !sameText(query.state, secrets.state)) refuse('state');
    const claim = stateClaim(flow, secrets.state);
    if (!(await this.states.claim(claim.key, claim.expiresAt, now))) refuse('state already used');
    if (query.error !== undefined) refuse('the provider answered an error');
    if (typeof query.code !== 'string' || query.code.length === 0 || query.code.length > MAX_CODE_LENGTH) refuse('code');

    const endpoints = await this.endpoints(now);
    const issuer = this.options.issuer;
    if (query.iss !== undefined && (issuer === null || query.iss !== issuer)) refuse('iss');
    if (query.iss === undefined && endpoints.issParameter) refuse('iss missing');

    const tokens = await exchangeCode(this.http, {
      endpoint: endpoints.token,
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret.secret,
      auth: this.options.tokenEndpointAuth,
      code: query.code!,
      redirectUri: flow.u,
      codeVerifier: secrets.codeVerifier,
      idToken: this.options.idToken,
    });

    const idClaims =
      tokens.idToken === undefined
        ? null
        : await validateIdToken(tokens.idToken, this.jwks!, {
            issuer: issuer!,
            issuerAliases: this.options.issuerAliases,
            clientId: this.options.clientId,
            algorithms: this.options.algorithms,
            clockSkewSeconds: this.options.clockSkewSeconds,
            nonce: secrets.nonce,
            accessToken: tokens.accessToken,
            now,
          });

    const wantsUserinfo = this.options.userinfo === true || (this.options.userinfo === 'auto' && endpoints.userinfo !== undefined);
    let userinfo: Readonly<Record<string, unknown>> | null = null;
    if (wantsUserinfo) {
      if (endpoints.userinfo === undefined) refuse('no userinfo endpoint');
      userinfo = await fetchUserinfo(this.http, endpoints.userinfo!, tokens.accessToken);
      if (idClaims !== null && userinfo.sub !== idClaims.sub) refuse('userinfo sub');
    }

    const raw = rawClaims(idClaims, userinfo);
    if (!hasRequiredClaims(raw, this.options.requiredClaims)) refuse('required claims');
    return mapClaims(this.options.strategy, this.options.claims, raw);
  }
}
