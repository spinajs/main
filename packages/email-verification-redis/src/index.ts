import { randomUUID } from 'node:crypto';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { EmailVerificationStore } from '@spinajs/email-verification';
import type { CachedVerdict, ListEntry, ListKind } from '@spinajs/email-verification';
import { Log, Logger } from '@spinajs/log';
import { chunk } from '@spinajs/util';
import { Redis } from 'ioredis';
import type { ChainableCommander, RedisOptions } from 'ioredis';

const INDEX = 'lists';
const VERSION = 'internal:listVersion';
const BATCH = 1000;
const TMP_TTL_MS = 3_600_000;
const DISPOSE_TIMEOUT_MS = 1000;
const VERDICTS = new Set(['allow', 'refuse', 'unknown']);

const listKey = (kind: ListKind, source: string) => `list:${kind}:${source}`;
const member = (kind: ListKind, source: string) => `${kind}:${source}`;
const splitMember = (m: string): [ListKind, string] => {
  const at = m.indexOf(':');
  return [m.slice(0, at) as ListKind, m.slice(at + 1)];
};

/**
 * Redis-backed store (ioredis). One set per list source, plus an index set of sources.
 * replaceSource builds a temporary set and RENAMEs it over the live one, so a reader
 * sees the old set or the new set.
 */
@Injectable(EmailVerificationStore)
export class RedisEmailVerificationStore extends EmailVerificationStore {
  @Config('emailVerification.redis')
  protected RedisConfig: RedisOptions;

  @Logger('email-verification')
  protected Log: Log;

  protected Client: Redis;

  public async resolve(): Promise<void> {
    this.Client = this.createClient();
    this.Client.on('error', (err: Error) => this.Log.error(err, 'Redis connection error'));
    await super.resolve();
  }

  public async dispose(): Promise<void> {
    const client = this.Client;
    if (!client) return;
    if (client.status !== 'ready') {
      client.disconnect();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      client.quit().then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), DISPOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) client.disconnect();
  }

  public async getVerdict(verifier: string, domain: string): Promise<CachedVerdict | null> {
    const raw = await this.Client.get(`verdict:${verifier}:${domain}`);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as CachedVerdict | null;
      return parsed && VERDICTS.has(parsed.result) ? parsed : null;
    } catch {
      return null;
    }
  }

  public async setVerdict(verifier: string, domain: string, verdict: CachedVerdict, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.Client.set(`verdict:${verifier}:${domain}`, JSON.stringify(verdict), 'PX', ttlSeconds * 1000);
  }

  public async loadLists(): Promise<ListEntry[]> {
    const entries: ListEntry[] = [];
    for (const m of await this.Client.smembers(INDEX)) {
      const [kind, source] = splitMember(m);
      for (const domain of await this.Client.smembers(listKey(kind, source))) entries.push({ domain, kind, source });
    }
    return entries;
  }

  public async listVersion(): Promise<string> {
    return (await this.Client.get(VERSION)) ?? '0';
  }

  public async upsertEntries(entries: readonly ListEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const bySource = new Map<string, { kind: ListKind; source: string; domains: string[] }>();
    for (const e of entries) {
      const m = member(e.kind, e.source);
      let group = bySource.get(m);
      if (!group) bySource.set(m, (group = { kind: e.kind, source: e.source, domains: [] }));
      group.domains.push(e.domain);
    }
    const tx = this.Client.multi();
    for (const [m, g] of bySource) {
      for (const part of chunk(g.domains, BATCH)) tx.sadd(listKey(g.kind, g.source), ...part);
      tx.sadd(INDEX, m);
    }
    tx.incr(VERSION);
    await this.exec(tx);
  }

  public async removeEntries(kind: ListKind, domains: readonly string[], source: string): Promise<void> {
    const tx = this.Client.multi();
    for (const part of chunk([...domains], BATCH)) tx.srem(listKey(kind, source), ...part);
    tx.incr(VERSION);
    await this.exec(tx);
  }

  public async replaceSource(source: string, kind: ListKind, domains: readonly string[]): Promise<void> {
    const key = listKey(kind, source);
    if (domains.length === 0) {
      await this.exec(this.Client.multi().del(key).srem(INDEX, member(kind, source)).incr(VERSION));
      return;
    }
    const tmp = `${key}:tmp:${randomUUID()}`;
    try {
      let first = true;
      for (const part of chunk([...domains], BATCH)) {
        const tx = this.Client.multi().sadd(tmp, ...part);
        // The TTL goes in with the first batch so a crash mid-load cannot leave the temporary set forever.
        if (first) tx.pexpire(tmp, TMP_TTL_MS);
        first = false;
        await this.exec(tx);
      }
      await this.exec(this.Client.multi().rename(tmp, key).persist(key).sadd(INDEX, member(kind, source)).incr(VERSION));
    } catch (err) {
      await this.Client.del(tmp).catch(() => undefined);
      throw err;
    }
  }

  public async getMeta(key: string): Promise<string | null> {
    return this.Client.get(`meta:${key}`);
  }

  public async setMeta(key: string, value: string): Promise<void> {
    await this.Client.set(`meta:${key}`, value);
  }

  protected async exec(tx: ChainableCommander): Promise<void> {
    const results = await tx.exec();
    if (results === null) throw new Error('Redis transaction was aborted');
    for (const [err] of results) if (err) throw err;
  }

  protected clientOptions(): RedisOptions {
    return { keyPrefix: 'ev:', ...this.RedisConfig };
  }

  protected createClient(): Redis {
    return new Redis(this.clientOptions());
  }
}
