import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

import { DomainVerifier, UNKNOWN } from '../contracts.js';
import type { DomainVerdict } from '../contracts.js';
import type { RdapOptions } from '../options.js';
import { SafeFetch } from '../safe-fetch.js';

const DAY_MS = 86_400_000;
const BOOTSTRAP_MAX_AGE_MS = DAY_MS;
const BOOTSTRAP_MAX_BYTES = 1024 * 1024;
const ANSWER_MAX_BYTES = 256 * 1024;

/** The domain, then each parent down to two labels, at most `max` names. */
export function rdapCandidates(domain: string, max: number): string[] {
  const labels = domain.split('.');
  const out: string[] = [];
  for (let i = 0; labels.length - i >= 2 && out.length < max; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export function parseRdapBootstrap(body: string): Map<string, string> {
  const servers = new Map<string, string>();
  const parsed = JSON.parse(body) as { services?: [string[], string[]][] };
  for (const [tlds, urls] of parsed.services ?? []) {
    const url = urls.find((u) => u.startsWith('https://'));
    if (!url) continue;
    const base = url.endsWith('/') ? url : `${url}/`;
    for (const tld of tlds) servers.set(tld.toLowerCase(), base);
  }
  return servers;
}

export function registrationTime(body: string): number | null {
  try {
    const events = (JSON.parse(body) as { events?: { eventAction?: string; eventDate?: string }[] }).events ?? [];
    const time = Date.parse(events.find((e) => e.eventAction === 'registration')?.eventDate ?? '');
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}

@Injectable(DomainVerifier)
export class RdapVerifier extends DomainVerifier {
  public readonly name = 'rdap';
  public readonly cacheable = true;

  @Config('emailVerification.rdap')
  protected Options: RdapOptions;

  @Autoinject(SafeFetch)
  protected Fetch: SafeFetch;

  @Logger('email-verification')
  protected Log: Log;

  protected Bootstrap: { loadedAt: number; servers: Map<string, string> } | undefined;

  protected BootstrapLoading: Promise<Map<string, string>> | undefined;

  public async verify(domain: string): Promise<DomainVerdict> {
    const base = (await this.servers()).get(domain.slice(domain.lastIndexOf('.') + 1));
    if (!base) return UNKNOWN;

    for (const candidate of rdapCandidates(domain, this.Options.maxLookups)) {
      const res = await this.Fetch.get(`${base}domain/${encodeURIComponent(candidate)}`, {
        timeoutMs: this.Options.requestTimeoutMs,
        maxBytes: ANSWER_MAX_BYTES,
        headers: { accept: 'application/rdap+json' },
      });
      if (res.status === 404) continue;
      if (res.status === 429) return { result: 'unknown', reason: 'rate_limited' };
      if (res.status !== 200) return UNKNOWN;
      const time = registrationTime(res.body);
      if (time === null) return UNKNOWN;
      return Date.now() - time < this.Options.minAgeDays * DAY_MS ? { result: 'refuse', reason: 'domain_too_new' } : { result: 'unknown', reason: 'registered' };
    }
    return UNKNOWN;
  }

  public ttlFor(verdict: DomainVerdict): number {
    switch (verdict.reason) {
      case 'domain_too_new':
        return this.Options.ttl.negative;
      case 'registered':
        return this.Options.ttl.positive;
      case 'rate_limited':
        return this.Options.rateLimitedTtlSeconds;
      default:
        return 0;
    }
  }

  protected async servers(): Promise<Map<string, string>> {
    if (this.Bootstrap && Date.now() - this.Bootstrap.loadedAt < BOOTSTRAP_MAX_AGE_MS) return this.Bootstrap.servers;
    this.BootstrapLoading ??= this.loadBootstrap().finally(() => (this.BootstrapLoading = undefined));
    return this.BootstrapLoading;
  }

  protected async loadBootstrap(): Promise<Map<string, string>> {
    try {
      const res = await this.Fetch.get(this.Options.bootstrapUrl, { timeoutMs: this.Options.requestTimeoutMs, maxBytes: BOOTSTRAP_MAX_BYTES });
      if (res.status !== 200) throw new Error(`RDAP bootstrap answered ${res.status}`);
      const servers = parseRdapBootstrap(res.body);
      this.Bootstrap = { loadedAt: Date.now(), servers };
      return servers;
    } catch (err) {
      if (!this.Bootstrap) throw err;
      this.Log.warn({ error: (err as Error).message }, 'RDAP bootstrap refresh failed, keeping the last one: ${error}');
      return this.Bootstrap.servers;
    }
  }
}
