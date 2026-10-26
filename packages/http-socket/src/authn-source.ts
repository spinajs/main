import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { AuthnService, CredentialExtractor } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, SignedRequest } from '@spinajs/authn/contracts';
import { Unauthenticated, principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { SINGLETON_CREDENTIAL_HEADERS, normalizeHeaders, repeatedHeader } from '@spinajs/http';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketHandshake, SocketPrincipalSource, SocketRevalidationResult } from './interfaces.js';

/** One answer for every failed attempt, as authn-http gives ( A02 ); the reason goes to authn's audit only. */
export const AUTHENTICATION_FAILED = 'authentication failed';

/**
 * `handshake.headers` with every repeated header joined from `rawHeaders`, as authn-http builds them: Node keeps only
 * the first of some (Host, User-Agent...). A value a subclass put in place of Node's own is kept.
 */
function withRepeatedHeaders(handshake: ISocketHandshake): Readonly<Record<string, string | string[] | undefined>> {
  const raw = handshake.rawHeaders;
  if (!raw) return handshake.headers;

  const joined = normalizeHeaders({ rawHeaders: raw });
  const headers: Record<string, string | string[] | undefined> = { ...handshake.headers };
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (Object.hasOwn(headers, name) && headers[name] === raw[i + 1] && joined[name] !== raw[i + 1]) headers[name] = joined[name];
  }
  return headers;
}

/**
 * The first of `singletons` a handshake without `rawHeaders` (a custom builder) may hold more than once. A repeat then
 * shows only in `headers`, so it fails closed: a value that is not a single string, or a name under two spellings.
 */
function repeatedInHeaders(headers: ISocketHandshake['headers'], singletons: readonly string[]): string | undefined {
  const wanted = new Set(singletons.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!wanted.has(key) || value === undefined) continue;
    if (typeof value !== 'string' || seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
}

/**
 * The handshake as authn's `SignedRequest`. Browsers cannot set WebSocket headers, so a token in
 * `auth.token` becomes `Authorization: Bearer`. The Cookie header is left out: a browser sends
 * cookies with a socket opened from any site, so they are no credential here ( SR-12 ).
 *
 * A header of `singletons` sent more than once throws `invalid_argument`, as authn-http answers 400: which copy is the
 * credential would be a guess. Any other repeated header reaches the extractors joined with ", ", as in authn-http.
 */
export function credentialRequest(handshake: ISocketHandshake, singletons: readonly string[] = SINGLETON_CREDENTIAL_HEADERS): SignedRequest {
  const repeated = handshake.rawHeaders === undefined ? repeatedInHeaders(handshake.headers, singletons) : repeatedHeader({ rawHeaders: handshake.rawHeaders }, singletons);
  if (repeated !== undefined) {
    throw new SocketException('invalid_argument', `the ${repeated} header was sent more than once`);
  }

  const headers: Record<string, string> = Object.create(null);

  for (const [name, value] of Object.entries(withRepeatedHeaders(handshake))) {
    const key = name.toLowerCase();
    if (key === 'cookie' || value === undefined) {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  const token = handshake.auth.token;
  if (typeof token === 'string' && token.length > 0 && headers.authorization === undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  return { method: 'GET', targetUri: handshake.url, headers };
}

/**
 * Bearer, key and signature credentials through `@spinajs/authn` ( throttled and audited by
 * AuthnService ), at order 50 like authz-http's AuthnPrincipalSource. Inert until an
 * AuthnService is registered.
 */
@Injectable(SocketPrincipalSource)
export class AuthnCredentialSource extends SocketPrincipalSource {
  public readonly name = 'authn';
  public readonly order = 50;

  @Logger('http-socket')
  protected Log: Log;

  // authn's own default, for an app whose configuration has no authn.token section
  @Config('authn.token.headerName', { defaultValue: 'x-api-key' })
  protected ApiKeyHeader: string | undefined;

  /** The headers whose repeat refuses the handshake: the singleton credential fields and `authn.token.headerName`. */
  protected get singletonHeaders(): readonly string[] {
    return typeof this.ApiKeyHeader === 'string' ? [...SINGLETON_CREDENTIAL_HEADERS, this.ApiKeyHeader] : SINGLETON_CREDENTIAL_HEADERS;
  }

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    if (!DI.check(AuthnService)) {
      return null;
    }

    const credentials = await this.extract(credentialRequest(handshake, this.singletonHeaders));
    if (!credentials) {
      return null;
    }

    const authn = (await DI.resolve(AuthnService)) as AuthnService;
    const result = await authn.authenticate(credentials, this.context(handshake));

    if (result.status === 'success') {
      return authn.principalOf(result);
    }

    // mfa_required falls through: a login pending MFA is no principal ( SR-07 )
    if (result.status === 'failure' && result.retryAfterSeconds !== undefined) {
      throw new SocketException('unauthenticated', AUTHENTICATION_FAILED, { retryAfterMs: result.retryAfterSeconds * 1000 });
    }

    throw new Unauthenticated(AUTHENTICATION_FAILED);
  }

  /** A rejected, expired or revoked credential is 'invalid'; a throttled attempt or a failing AuthnService is 'unavailable'. */
  public async revalidate(handshake: ISocketHandshake, principal: Principal): Promise<SocketRevalidationResult> {
    try {
      if (!DI.check(AuthnService)) {
        return 'unavailable';
      }

      const credentials = await this.extract(credentialRequest(handshake, this.singletonHeaders));
      if (!credentials) {
        return 'invalid';
      }

      const authn = (await DI.resolve(AuthnService)) as AuthnService;
      const result = await authn.authenticate(credentials, this.context(handshake));

      if (result.status === 'success') {
        const again = await authn.principalOf(result);
        return principalKey(again) === principalKey(principal) ? { status: 'valid', principal: again } : 'invalid';
      }

      return result.status === 'failure' && result.reason === 'throttled' ? 'unavailable' : 'invalid';
    } catch (err) {
      if (err instanceof SocketException && err.code === 'invalid_argument') {
        return 'invalid';
      }
      this.Log.warn(err as Error, 'AuthnService failed to revalidate a socket credential');
      return 'unavailable';
    }
  }

  protected context(handshake: ISocketHandshake): AuthnContext {
    const userAgent = handshake.headers['user-agent'];
    return { ip: handshake.address, userAgent: typeof userAgent === 'string' ? userAgent : undefined, now: new Date(), purpose: 'request' };
  }

  protected async extract(request: SignedRequest): Promise<Credentials | null> {
    const extractors = [...((await DI.resolve(Array.ofType(CredentialExtractor))) as CredentialExtractor[])].sort((a, b) => a.order - b.order);

    for (const extractor of extractors) {
      const credentials = extractor.extract(request);
      if (credentials) {
        return credentials;
      }
    }

    return null;
  }
}
