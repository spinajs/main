import { Injectable } from '@spinajs/di';
import { EmailVerificationStore } from '../contracts.js';
import type { CachedVerdict, ListEntry, ListKind } from '../contracts.js';

const listKey = (kind: ListKind, source: string) => `${kind}|${source}`;

/** One process only, lost on restart: for tests and single-node apps. */
@Injectable(EmailVerificationStore)
export class MemoryEmailVerificationStore extends EmailVerificationStore {
  protected Verdicts = new Map<string, { verdict: CachedVerdict; expiresAt: number }>();
  protected Lists = new Map<string, { kind: ListKind; source: string; domains: Set<string> }>();
  protected Meta = new Map<string, string>();
  protected Version = 0;

  public async getVerdict(verifier: string, domain: string): Promise<CachedVerdict | null> {
    const key = `${verifier}:${domain}`;
    const entry = this.Verdicts.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.Verdicts.delete(key);
      return null;
    }
    return { ...entry.verdict };
  }

  public async setVerdict(verifier: string, domain: string, verdict: CachedVerdict, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    this.Verdicts.set(`${verifier}:${domain}`, { verdict: { ...verdict }, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  public async loadLists(): Promise<ListEntry[]> {
    return [...this.Lists.values()].flatMap(({ kind, source, domains }) => [...domains].map((domain) => ({ domain, kind, source })));
  }

  public async listVersion(): Promise<string> {
    return String(this.Version);
  }

  public async upsertEntries(entries: readonly ListEntry[]): Promise<void> {
    for (const e of entries) {
      const key = listKey(e.kind, e.source);
      let list = this.Lists.get(key);
      if (!list) this.Lists.set(key, (list = { kind: e.kind, source: e.source, domains: new Set() }));
      list.domains.add(e.domain);
    }
    this.Version++;
  }

  public async removeEntries(kind: ListKind, domains: readonly string[], source: string): Promise<void> {
    const key = listKey(kind, source);
    const list = this.Lists.get(key);
    if (list) {
      domains.forEach((d) => list.domains.delete(d));
      if (list.domains.size === 0) this.Lists.delete(key);
    }
    this.Version++;
  }

  public async replaceSource(source: string, kind: ListKind, domains: readonly string[]): Promise<void> {
    const key = listKey(kind, source);
    if (domains.length === 0) this.Lists.delete(key);
    else this.Lists.set(key, { kind, source, domains: new Set(domains) });
    this.Version++;
  }

  public async getMeta(key: string): Promise<string | null> {
    return this.Meta.get(key) ?? null;
  }

  public async setMeta(key: string, value: string): Promise<void> {
    this.Meta.set(key, value);
  }
}
