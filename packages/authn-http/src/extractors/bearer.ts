import { Autoinject, PerChildInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { CredentialExtractor } from '@spinajs/authn/contracts';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

// RFC 6750 b64token. A header sent twice reaches the extractors joined with ", ", which never matches.
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;
const MALFORMED_BEARER = /^Bearer +(.+)$/is;

const DEFAULT_TOKEN_PREFIX = 'spt_';
const DEFAULT_ASSERTION_TYP = 'spinajs-client+jwt';

function jwsTyp(header: string): unknown {
  try {
    return (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { typ?: unknown } | null)?.typ;
  } catch {
    return undefined;
  }
}

/**
 * `Authorization: Bearer <value>` (scheme in any case): an `authn.token.prefix` token ⇒ bearer; a three-part value ⇒
 * jws-assertion when its JWS header `typ` is `authn.keys.assertion.typ`, else bearer (a JWT). Any other value is
 * someone else's token (a telemetry service token, say) and gives no credentials, so no strategy runs and no failure
 * counts. A malformed or repeated header ⇒ null, unless its value starts with the token prefix: that is a bad credential
 * of ours, a bearer that fails, so resolution stops there and never falls through to `x-api-key`.
 */
@PerChildInstance()
export class AuthorizationBearerExtractor extends CredentialExtractor {
  public readonly order: number = 20;

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  public extract(req: SignedRequest): Credentials | null {
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : undefined;
    if (header === undefined) return null;
    const prefix = this.Configuration.get<string>('authn.token.prefix', DEFAULT_TOKEN_PREFIX);
    const ours = (value: string) => typeof prefix === 'string' && prefix !== '' && value.startsWith(prefix);

    const token = BEARER.exec(header)?.[1];
    if (token === undefined) {
      const value = MALFORMED_BEARER.exec(header)?.[1];
      return value !== undefined && ours(value) ? { kind: 'bearer', token: value } : null;
    }
    if (ours(token)) return { kind: 'bearer', token };

    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => p === '')) return null;
    return jwsTyp(parts[0]) === this.Configuration.get<string>('authn.keys.assertion.typ', DEFAULT_ASSERTION_TYP) ? { kind: 'jws-assertion', jws: token } : { kind: 'bearer', token };
  }
}

/**
 * The `authn.token.headerName` header (default `x-api-key`) ⇒ bearer, only for an `authn.token.prefix` token: the header
 * name is common, so any other value is someone else's key and gives no credentials. A malformed or repeated value ⇒
 * null. An opaque `Authorization` bearer gives null first, so a prefix token here still authenticates, as in 2.x.
 */
@PerChildInstance()
export class ApiKeyHeaderExtractor extends CredentialExtractor {
  public readonly order: number = 30;

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  public extract(req: SignedRequest): Credentials | null {
    const name = this.Configuration.get<string>('authn.token.headerName', 'x-api-key');
    const value = typeof name === 'string' && name !== '' ? req.headers[name.toLowerCase()] : undefined;
    const token = typeof value === 'string' ? value.trim() : '';
    const prefix = this.Configuration.get<string>('authn.token.prefix', DEFAULT_TOKEN_PREFIX);
    return TOKEN.test(token) && typeof prefix === 'string' && prefix !== '' && token.startsWith(prefix) ? { kind: 'bearer', token } : null;
  }
}
