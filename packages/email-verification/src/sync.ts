import { AutoinjectService, Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';

import './register-schema.js';
import { EmailVerificationStore, LIST_KINDS, type ListKind } from './contracts.js';
import { normalizeDomain } from './domain.js';
import type { ListSourceOptions, ListsOptions } from './options.js';
import { SafeFetch } from './safe-fetch.js';

const SYNC_TIMEOUT_MS = 30_000;
const SYNC_MAX_BYTES = 16 * 1024 * 1024;
const MAX_DOMAIN_LENGTH = 253;

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new InvalidArgument('invalid JSON');
    }
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
    const domain = typeof r === 'string' && r.length <= MAX_DOMAIN_LENGTH ? normalizeDomain(r) : null;
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
    const names = this.Options.sources.map((s) => s.name);
    const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (duplicates.length > 0) throw new InvalidArgument(`duplicate list source name: ${duplicates.join(', ')}`);
    const sources = this.Options.sources.filter((s) => only === undefined || s.name === only);
    if (only !== undefined && sources.length === 0) throw new InvalidArgument(`no list source named ${only}`);
    const outcomes: SyncOutcome[] = [];
    for (const source of sources) outcomes.push(await this.syncOne(source));
    return outcomes;
  }

  protected async syncOne(source: ListSourceOptions): Promise<SyncOutcome> {
    const etagKey = `sync:${source.name}:etag`;
    const countKey = `sync:${source.name}:count`;
    const originKey = `sync:${source.name}:origin`;
    const pendingKey = `sync:${source.name}:pendingClear`;
    try {
      const origin = `${source.kind}|${source.url}`;
      const storedOrigin = await this.Store.getMeta(originKey);
      const sameOrigin = storedOrigin === origin;
      const etag = sameOrigin ? await this.Store.getMeta(etagKey) : null;
      const res = await this.Fetch.get(source.url, { timeoutMs: SYNC_TIMEOUT_MS, maxBytes: SYNC_MAX_BYTES, headers: etag ? { 'if-none-match': etag } : {} });
      if (res.status === 304) return { source: source.name, status: 'unchanged' };
      if (res.status !== 200) throw new Error(`answered ${res.status}`);

      const { domains, invalid } = parseList(res.body, source.format);
      const stored = sameOrigin ? Number((await this.Store.getMeta(countKey)) ?? 0) : 0;
      const previous = Number.isFinite(stored) ? stored : 0;
      if (domains.length === 0 || domains.length < previous * this.Options.minKeepRatio) {
        this.Log.warn({ source: source.name, count: domains.length, previous }, 'List ${source} gave ${count} domains (previously ${previous}); the old list stays');
        return { source: source.name, status: 'refused', count: domains.length, invalid };
      }

      const asKinds = (raw: string | null | undefined) => (raw ?? '').split(',').filter((k): k is ListKind => (LIST_KINDS as readonly string[]).includes(k) && k !== source.kind);
      const toClear = [...new Set([...asKinds(await this.Store.getMeta(pendingKey)), ...asKinds(storedOrigin?.split('|', 1)[0])])];
      // A failure past this point must leave the origin mismatched so the next run refetches in full;
      // pendingClear also names the kind written here, which a reverted config would have to clear.
      await this.Store.setMeta(pendingKey, [...toClear, source.kind].join(','));
      await this.Store.setMeta(originKey, '');
      await this.Store.replaceSource(source.name, source.kind, domains);
      for (const kind of toClear) await this.Store.replaceSource(source.name, kind, []);
      await this.Store.setMeta(pendingKey, '');
      await this.Store.setMeta(countKey, String(domains.length));
      await this.Store.setMeta(etagKey, res.headers.get('etag') ?? '');
      await this.Store.setMeta(originKey, origin);
      this.Log.info({ source: source.name, count: domains.length, invalid }, 'List ${source} updated: ${count} domains, ${invalid} invalid lines');
      return { source: source.name, status: 'updated', count: domains.length, invalid };
    } catch (err) {
      this.Log.warn({ source: source.name, error: (err as Error).message }, 'List ${source} sync failed, the old list stays: ${error}');
      return { source: source.name, status: 'failed', error: (err as Error).message };
    }
  }
}
