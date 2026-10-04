import type { OidcHttpClient } from './http/client.js';
import { checkedUrl, isPlainObject } from './support.js';

/** The members of a discovery document the flow uses, validated. */
export interface OidcProviderMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly userinfo_endpoint?: string;
  /** RFC 9207: the provider sends iss with every authorization response. */
  readonly authorization_response_iss_parameter_supported: boolean;
}

export const DISCOVERY_MAX_AGE_MS = 3_600_000;
/** After a failed fetch, the next one waits this long; the cached document is served meanwhile. */
export const DISCOVERY_RETRY_MS = 60_000;

export function discoveryUrlOf(issuer: string): string {
  return `${issuer.endsWith('/') ? issuer : `${issuer}/`}.well-known/openid-configuration`;
}

/** Discovery of one provider: fetched on first use, kept for an hour, a failed refresh keeps the last good document. */
export class OidcDiscovery {
  protected document: OidcProviderMetadata | undefined;
  protected fetchedAt = 0;
  protected failedAt: number | undefined;
  protected inflight: Promise<OidcProviderMetadata> | undefined;

  /** @param relaxed - http endpoints allowed (development and test) */
  constructor(
    public readonly issuer: string,
    protected readonly http: OidcHttpClient,
    protected readonly relaxed: boolean,
  ) {}

  public async metadata(now: number = Date.now()): Promise<OidcProviderMetadata> {
    if (this.document && now < this.fetchedAt + DISCOVERY_MAX_AGE_MS) {
      return this.document;
    }
    if (this.inflight) {
      return this.inflight;
    }
    if (this.failedAt !== undefined && now < this.failedAt + DISCOVERY_RETRY_MS) {
      if (this.document) return this.document;
      throw new Error(`authn-oidc: discovery of ${this.issuer} failed recently`);
    }
    this.inflight = this.fetch().then(
      (doc) => {
        this.document = doc;
        this.fetchedAt = now;
        this.failedAt = undefined;
        return doc;
      },
      (err: unknown) => {
        this.failedAt = now;
        if (this.document) return this.document;
        throw err;
      },
    );
    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  protected async fetch(): Promise<OidcProviderMetadata> {
    const { status, json } = await this.http.getJson(discoveryUrlOf(this.issuer));
    if (status !== 200 || !isPlainObject(json)) {
      throw new Error(`authn-oidc: discovery of ${this.issuer} answered HTTP ${status} without a JSON object`);
    }
    return this.validate(json);
  }

  protected validate(d: Record<string, unknown>): OidcProviderMetadata {
    const bad = (what: string): never => {
      throw new Error(`authn-oidc: the discovery document of ${this.issuer} ${what}`);
    };
    if (d.issuer !== this.issuer) {
      bad('names another issuer');
    }
    const endpoint = (member: string): string => {
      const v = d[member];
      if (!checkedUrl(v, { relaxed: this.relaxed, query: true })) {
        bad(`has no valid ${member} (an absolute ${this.relaxed ? 'http or https' : 'https'} URL)`);
      }
      return v as string;
    };
    const listed = (member: string, needed: string): void => {
      const v = d[member];
      if (v !== undefined && !(Array.isArray(v) && v.includes(needed))) {
        bad(`does not list ${needed} in ${member}`);
      }
    };
    listed('response_types_supported', 'code');
    listed('code_challenge_methods_supported', 'S256');
    return Object.freeze({
      issuer: this.issuer,
      authorization_endpoint: endpoint('authorization_endpoint'),
      token_endpoint: endpoint('token_endpoint'),
      jwks_uri: endpoint('jwks_uri'),
      ...(d.userinfo_endpoint !== undefined ? { userinfo_endpoint: endpoint('userinfo_endpoint') } : {}),
      authorization_response_iss_parameter_supported: d.authorization_response_iss_parameter_supported === true,
    });
  }
}
