import { AutoinjectService, Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

import { ADMIN_SOURCE, DomainVerifier, EmailVerificationStore, UNKNOWN } from '../contracts.js';
import type { DomainVerdict, ListKind } from '../contracts.js';
import { suffixes } from '../domain.js';
import { withTimeout } from '../timeout.js';

interface Snapshot {
  readonly version: string | null;
  readonly lists: ReadonlyMap<ListKind, ReadonlyMap<string, string>>;
}

@Injectable(DomainVerifier)
export class ListVerifier extends DomainVerifier {
  public readonly name = 'list';
  public readonly cacheable = false;

  @Logger('email-verification')
  protected Log: Log;

  @Config('emailVerification.lists.refreshSeconds')
  protected RefreshSeconds: number;

  @Config('emailVerification.enabled')
  protected Enabled: boolean;

  @Config('emailVerification.timeoutMs')
  protected TimeoutMs: number;

  @AutoinjectService('emailVerification.store', EmailVerificationStore)
  protected Store: EmailVerificationStore;

  protected Snapshot: Snapshot = { version: null, lists: new Map() };

  protected Timer: ReturnType<typeof setInterval> | undefined;

  protected Refreshing: Promise<void> | undefined;

  protected Generation = 0;

  protected Applied = 0;

  public async resolve(): Promise<void> {
    if (!this.Enabled) {
      await super.resolve();
      return;
    }
    try {
      await withTimeout(this.reload(), this.TimeoutMs);
    } catch (err) {
      this.Log.error(err as Error, 'Cannot load the email domain lists; the list verifier answers unknown until a refresh succeeds');
    }
    clearInterval(this.Timer);
    this.Timer = setInterval(() => {
      this.refresh().catch((err: Error) => this.Log.warn({ error: err.message }, 'Email domain list refresh failed: ${error}'));
    }, this.RefreshSeconds * 1000);
    this.Timer.unref?.();
    await super.resolve();
  }

  public async dispose(): Promise<void> {
    clearInterval(this.Timer);
    this.Timer = undefined;
  }

  /** Joins the refresh in flight, if any, so a slow store never piles up timer ticks. */
  public refresh(): Promise<void> {
    this.Refreshing ??= this.refreshNow().finally(() => (this.Refreshing = undefined));
    return withTimeout(this.Refreshing, this.TimeoutMs);
  }

  protected async refreshNow(): Promise<void> {
    if ((await this.Store.listVersion()) !== this.Snapshot.version) await this.reload();
  }

  public async reload(): Promise<void> {
    const generation = ++this.Generation;
    const version = await this.Store.listVersion();
    const lists = new Map<ListKind, Map<string, string>>();
    for (const e of await this.Store.loadLists()) {
      let byDomain = lists.get(e.kind);
      if (!byDomain) lists.set(e.kind, (byDomain = new Map()));
      if (!byDomain.has(e.domain) || e.source === ADMIN_SOURCE) byDomain.set(e.domain, e.source);
    }
    if (generation > this.Applied) {
      this.Snapshot = { version, lists };
      this.Applied = generation;
    }
  }

  /** Source of the entry that lists `domain` or one of its parents. */
  public match(kind: ListKind, domain: string): string | undefined {
    const byDomain = this.Snapshot.lists.get(kind);
    if (!byDomain) return undefined;
    for (const s of suffixes(domain)) {
      const source = byDomain.get(s);
      if (source !== undefined) return source;
    }
    return undefined;
  }

  public async verify(domain: string): Promise<DomainVerdict> {
    const allowedBy = this.match('allow', domain);
    if (allowedBy !== undefined) return { result: 'allow', source: `list:${allowedBy}` };
    const blockedBy = this.match('block', domain);
    if (blockedBy !== undefined) return { result: 'refuse', reason: 'listed', source: `list:${blockedBy}` };
    return UNKNOWN;
  }

  public ttlFor(): number {
    return 0;
  }
}
