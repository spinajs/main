import { PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { parseOrigin } from '@spinajs/http';
import { CredentialExtractor } from '@spinajs/authn/contracts';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

/**
 * `authn.http.publicOrigin` normalised to an origin: the one clients put in a signature's `@target-uri`, never taken from
 * Host. undefined when unset. The schema judges the shape; `parseOrigin` still refuses a port above 65535 or a broken IPv6
 * literal, which a pattern cannot.
 */
export function publicOriginOf(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const origin = parseOrigin(value);
  if (origin === undefined) throw new InvalidOption(`authn.http.publicOrigin must be an origin (scheme://host[:port]); got ${JSON.stringify(value)}`);
  return origin;
}

/**
 * `signature` + `signature-input` headers ⇒ http-signature. `req.targetUri` is the origin-form target (path and
 * query); the credential's target is `authn.http.publicOrigin` plus that path. null without the setting, and for any
 * other target form (absolute-form, `*`), which no client signs.
 */
@PerChildInstance()
export class HttpSignatureExtractor extends CredentialExtractor {
  public readonly order: number = 10;

  @Config('authn.http.publicOrigin')
  protected PublicOrigin: string | null | undefined;

  private memo: { readonly raw: string | null | undefined; readonly origin: string | undefined } | undefined;

  protected get origin(): string | undefined {
    const raw = this.PublicOrigin;
    if (this.memo === undefined || this.memo.raw !== raw) this.memo = { raw, origin: publicOriginOf(raw) };
    return this.memo.origin;
  }

  public extract(req: SignedRequest): Credentials | null {
    if (typeof req.headers.signature !== 'string' || typeof req.headers['signature-input'] !== 'string' || !req.targetUri.startsWith('/')) return null;
    const origin = this.origin;
    if (origin === undefined) return null;
    return { kind: 'http-signature', request: { method: req.method, targetUri: `${origin}${req.targetUri}`, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) } };
  }
}
