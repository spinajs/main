import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { parseOrigin } from '@spinajs/http';
import { CredentialExtractor } from '@spinajs/authn/contracts';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

const PUBLIC_ORIGIN_KEY = 'authn.http.publicOrigin';

/**
 * `authn.http.publicOrigin`: the origin clients put in a signature's `@target-uri`, never taken from Host. undefined
 * when unset; a value that is not an origin throws.
 */
export function signaturePublicOrigin(config: Pick<Configuration, 'get'>): string | undefined {
  const value = config.get<unknown>(PUBLIC_ORIGIN_KEY);
  if (value === undefined || value === null) return undefined;
  const origin = parseOrigin(value);
  if (origin === undefined) throw new InvalidOption(`${PUBLIC_ORIGIN_KEY} must be an origin (scheme://host[:port]); got ${JSON.stringify(value) ?? String(value)}`);
  return origin;
}

/** `signature` + `signature-input` headers ⇒ http-signature; null without `authn.http.publicOrigin`. */
@PerChildInstance()
@Injectable(CredentialExtractor)
export class HttpSignatureExtractor extends CredentialExtractor {
  public readonly order: number = 10;

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  public extract(req: SignedRequest): Credentials | null {
    if (typeof req.headers.signature !== 'string' || typeof req.headers['signature-input'] !== 'string') return null;
    if (signaturePublicOrigin(this.Configuration) === undefined) return null;
    return { kind: 'http-signature', request: req };
  }
}
