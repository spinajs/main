import { Autoinject, PerChildInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { CredentialExtractor } from '@spinajs/authn/contracts';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

// RFC 6750 b64token. A header sent twice reaches the extractors joined with ", ", which never matches.
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

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
 * counts. A malformed or repeated header ⇒ null.
 */
@PerChildInstance()
export class AuthorizationBearerExtractor extends CredentialExtractor {
  public readonly order: number = 20;

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  public extract(req: SignedRequest): Credentials | null {
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header.trim())?.[1] : undefined;
    if (token === undefined) return null;

    const prefix = this.Configuration.get<string>('authn.token.prefix', DEFAULT_TOKEN_PREFIX);
    if (typeof prefix === 'string' && prefix !== '' && token.startsWith(prefix)) return { kind: 'bearer', token };

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
