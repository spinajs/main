import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

import { DomainVerifier, UNKNOWN } from '../contracts.js';
import type { DomainVerdict } from '../contracts.js';
import type { HttpProviderOptions } from '../options.js';
import { SafeFetch } from '../safe-fetch.js';

const ANSWER_MAX_BYTES = 64 * 1024;
const CLEAN: DomainVerdict = { result: 'unknown', reason: 'clean' };

export function jsonPath(value: unknown, path: string): unknown {
  let current = value;
  for (const step of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}

@Injectable(DomainVerifier)
export class HttpDomainVerifier extends DomainVerifier {
  public readonly name = 'http';
  public readonly cacheable = true;

  @Config('emailVerification.http.providers')
  protected Providers: HttpProviderOptions[];

  @Config('emailVerification.timeoutMs')
  protected TimeoutMs: number;

  @Autoinject(SafeFetch)
  protected Fetch: SafeFetch;

  @Logger('email-verification')
  protected Log: Log;

  public async verify(domain: string): Promise<DomainVerdict> {
    if (this.Providers.length === 0) return UNKNOWN;
    let failed = false;
    for (const provider of this.Providers) {
      const verdict = await this.ask(provider, domain);
      if (verdict.result === 'refuse') return verdict;
      if (verdict.reason !== CLEAN.reason) failed = true;
    }
    return failed ? UNKNOWN : CLEAN;
  }

  public ttlFor(verdict: DomainVerdict): number {
    if (verdict.result === 'refuse') return this.Providers.find((p) => `http:${p.name}` === verdict.source)?.ttlSeconds ?? 0;
    if (verdict.reason === CLEAN.reason) return Math.min(...this.Providers.map((p) => p.ttlSeconds));
    return 0;
  }

  protected async ask(provider: HttpProviderOptions, domain: string): Promise<DomainVerdict> {
    try {
      const res = await this.Fetch.get(provider.url.replace('{domain}', encodeURIComponent(domain)), {
        timeoutMs: this.TimeoutMs,
        maxBytes: ANSWER_MAX_BYTES,
        headers: provider.headers,
      });
      if (res.status !== 200) return UNKNOWN;
      const value = jsonPath(JSON.parse(res.body), provider.resultPath);
      if (value === undefined) return UNKNOWN;
      return provider.refuseWhen.some((w) => w === value) ? { result: 'refuse', reason: provider.reason, source: `http:${provider.name}` } : CLEAN;
    } catch (err) {
      this.Log.warn({ provider: provider.name, error: (err as Error).message }, 'Domain check provider ${provider} failed: ${error}');
      return UNKNOWN;
    }
  }
}
