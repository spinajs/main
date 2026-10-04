import { Injectable } from '@spinajs/di';

export type OidcHttpHeaders = Readonly<Record<string, string>>;

export interface OidcHttpResponse {
  readonly status: number;
  /** The parsed JSON body. */
  readonly json: unknown;
}

/**
 * Every request authn-oidc sends to a provider (discovery, JWKS, token, userinfo) goes through this port, so tests can
 * play the provider in memory. Implementations throw on a transport failure or a body that is not JSON; the callers
 * check the status, the URL scheme and the shape.
 */
export abstract class OidcHttpClient {
  abstract getJson(url: string, headers?: OidcHttpHeaders): Promise<OidcHttpResponse>;
  abstract postForm(url: string, form: Readonly<Record<string, string>>, headers?: OidcHttpHeaders): Promise<OidcHttpResponse>;
}

export const OIDC_HTTP_TIMEOUT_MS = 5_000;
export const OIDC_HTTP_MAX_BODY_BYTES = 1024 * 1024;

/** Global fetch; no redirects (a redirect answer is a failure), a timeout and a body cap. */
@Injectable(OidcHttpClient)
export class FetchOidcHttpClient extends OidcHttpClient {
  public async getJson(url: string, headers: OidcHttpHeaders = {}): Promise<OidcHttpResponse> {
    return this.send(url, { method: 'GET', headers: { ...headers, accept: 'application/json' } });
  }

  public async postForm(url: string, form: Readonly<Record<string, string>>, headers: OidcHttpHeaders = {}): Promise<OidcHttpResponse> {
    return this.send(url, {
      method: 'POST',
      headers: { ...headers, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  protected async send(url: string, init: RequestInit): Promise<OidcHttpResponse> {
    const protocol = new URL(url).protocol;
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new Error(`authn-oidc: refused to fetch a ${protocol} URL`);
    }
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS) });
    const text = await this.readCapped(response);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`authn-oidc: the provider answered HTTP ${response.status} without a JSON body`);
    }
    return { status: response.status, json };
  }

  protected async readCapped(response: Response): Promise<string> {
    if (!response.body) {
      return '';
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OIDC_HTTP_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('authn-oidc: the provider answer is too large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
