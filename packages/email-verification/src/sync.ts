import { AutoinjectService, Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';

import { EmailVerificationStore } from './contracts.js';
import { normalizeDomain } from './domain.js';
import type { ListSourceOptions, ListsOptions } from './options.js';
import { SafeFetch } from './safe-fetch.js';

const SYNC_TIMEOUT_MS = 30_000;
const SYNC_MAX_BYTES = 16 * 1024 * 1024;

export interface SyncOutcome {
  readonly source: string;
  readonly status: 'updated' | 'unchanged' | 'refused' | 'failed';
  readonly count?: number;
  readonly invalid?: number;
  readonly error?: string;
}

export function parseList(body: string, format: 'lines' | 'json'): { domains: string[]; invalid: number } {
  let raw: unknown[];
  if (format === 'json') {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new InvalidArgument('a json list must be an array of domains');
    raw = parsed;
  } else {
    raw = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
  }
  const domains = new Set<string>();
  let invalid = 0;
  for (const r of raw) {
    const domain = typeof r === 'string' ? normalizeDomain(r) : null;
    if (domain === null) invalid++;
    else domains.add(domain);
  }
  return { domains: [...domains], invalid };
}

@Injectable()
export class DomainListSync {
  @Config('emailVerification.lists')
  protected Options: ListsOptions;

  @AutoinjectService('emailVerification.store', EmailVerificationStore)
  protected Store: EmailVerificationStore;

  @Autoinject(SafeFetch)
  protected Fetch: SafeFetch;

  @Logger('email-verification')
  protected Log: Log;

  public async run(only?: string): Promise<SyncOutcome[]> {
    const sources = this.Options.sources.filter((s) => only === undefined || s.name === only);
    if (only !== undefined && sources.length === 0) throw new InvalidArgument(`no list source named ${only}`);
    const outcomes: SyncOutcome[] = [];
    for (const source of sources) outcomes.push(await this.syncOne(source));
    return outcomes;
  }

  protected async syncOne(source: ListSourceOptions): Promise<SyncOutcome> {
    const etagKey = `sync:${source.name}:etag`;
    const countKey = `sync:${source.name}:count`;
    try {
      const etag = await this.Store.getMeta(etagKey);
      const res = await this.Fetch.get(source.url, { timeoutMs: SYNC_TIMEOUT_MS, maxBytes: SYNC_MAX_BYTES, headers: etag ? { 'if-none-match': etag } : {} });
      if (res.status === 304) return { source: source.name, status: 'unchanged' };
      if (res.status !== 200) throw new Error(`answered ${res.status}`);

      const { domains, invalid } = parseList(res.body, source.format);
      const previous = Number((await this.Store.getMeta(countKey)) ?? 0);
      if (domains.length < previous * this.Options.minKeepRatio) {
        this.Log.warn({ source: source.name, count: domains.length, previous }, 'List ${source} shrank from ${previous} to ${count} domains; the old list stays');
        return { source: source.name, status: 'refused', count: domains.length, invalid };
      }

      await this.Store.replaceSource(source.name, source.kind, domains);
      await this.Store.setMeta(countKey, String(domains.length));
      const next = res.headers.get('etag');
      if (next) await this.Store.setMeta(etagKey, next);
      this.Log.info({ source: source.name, count: domains.length, invalid }, 'List ${source} updated: ${count} domains, ${invalid} invalid lines');
      return { source: source.name, status: 'updated', count: domains.length, invalid };
    } catch (err) {
      this.Log.warn({ source: source.name, error: (err as Error).message }, 'List ${source} sync failed, the old list stays: ${error}');
      return { source: source.name, status: 'failed', error: (err as Error).message };
    }
  }
}
