import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';
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
 * `Authorization: Bearer <value>` (scheme in any case): a three-part value whose JWS header has `typ`
 * `authn.keys.assertion.typ` ⇒ jws-assertion; any other value, a `authn.token.prefix` token or a JWT, ⇒ bearer.
 * A malformed or repeated header ⇒ null.
 */
@PerChildInstance()
@Injectable(CredentialExtractor)
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
    if (parts.length === 3 && parts.every((p) => p !== '') && jwsTyp(parts[0]) === this.Configuration.get<string>('authn.keys.assertion.typ', DEFAULT_ASSERTION_TYP)) {
      return { kind: 'jws-assertion', jws: token };
    }
    return { kind: 'bearer', token };
  }
}

/** The `authn.token.headerName` header (default `x-api-key`) ⇒ bearer; a malformed or repeated value ⇒ null. */
@PerChildInstance()
@Injectable(CredentialExtractor)
export class ApiKeyHeaderExtractor extends CredentialExtractor {
  public readonly order: number = 30;

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  public extract(req: SignedRequest): Credentials | null {
    const name = this.Configuration.get<string>('authn.token.headerName', 'x-api-key');
    const value = typeof name === 'string' && name !== '' ? req.headers[name.toLowerCase()] : undefined;
    const token = typeof value === 'string' ? value.trim() : '';
    return TOKEN.test(token) ? { kind: 'bearer', token } : null;
  }
}
