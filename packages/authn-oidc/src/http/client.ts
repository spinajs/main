import { DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { appEnvOf } from '@spinajs/authn-session';

import { isRelaxedEnv } from '../support.js';

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

/**
 * Global fetch; https only unless the env is development or test, no redirects (a redirect answer is a failure), JSON
 * answers only, a timeout and a body cap.
 */
@Injectable(OidcHttpClient)
export class FetchOidcHttpClient extends OidcHttpClient {
  /** @param relaxed - allow http; default: from the app env as authn-session reads it (none set: production) */
  constructor(protected readonly relaxed?: boolean) {
    super();
  }

  protected configuration(): Configuration | undefined {
    return DI.get(Configuration) ?? undefined;
  }

  protected allowsHttp(): boolean {
    const config = this.configuration();
    return this.relaxed ?? (config ? isRelaxedEnv(appEnvOf(config)) : false);
  }

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
    if (protocol !== 'https:' && !(protocol === 'http:' && this.allowsHttp())) {
      throw new Error(`authn-oidc: refused to fetch a ${protocol} URL`);
    }
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(`authn-oidc: the provider answered a redirect (HTTP ${response.status})`);
    }
    if (!/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new Error(`authn-oidc: the provider answered HTTP ${response.status} without a JSON content type`);
    }
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
