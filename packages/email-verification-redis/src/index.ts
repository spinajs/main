import { randomUUID } from 'node:crypto';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { EmailVerificationStore } from '@spinajs/email-verification';
import type { CachedVerdict, ListEntry, ListKind } from '@spinajs/email-verification';
import { Log, Logger } from '@spinajs/log';
import { chunk } from '@spinajs/util';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

const INDEX = 'lists';
const VERSION = 'meta:listVersion';
const BATCH = 1000;
const TMP_TTL_MS = 3_600_000;

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
    try {
      await this.Client?.quit();
    } catch {
      this.Client?.disconnect();
    }
  }

  public async getVerdict(verifier: string, domain: string): Promise<CachedVerdict | null> {
    const raw = await this.Client.get(`verdict:${verifier}:${domain}`);
    return raw === null ? null : (JSON.parse(raw) as CachedVerdict);
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
    const tx = this.Client.multi();
    for (const e of entries) {
      tx.sadd(listKey(e.kind, e.source), e.domain);
      tx.sadd(INDEX, member(e.kind, e.source));
    }
    tx.incr(VERSION);
    await tx.exec();
  }

  public async removeEntries(kind: ListKind, domains: readonly string[], source: string): Promise<void> {
    const tx = this.Client.multi();
    if (domains.length > 0) tx.srem(listKey(kind, source), ...domains);
    tx.incr(VERSION);
    await tx.exec();
  }

  public async replaceSource(source: string, kind: ListKind, domains: readonly string[]): Promise<void> {
    const key = listKey(kind, source);
    if (domains.length === 0) {
      await this.Client.multi().del(key).srem(INDEX, member(kind, source)).incr(VERSION).exec();
      return;
    }
    const tmp = `${key}:tmp:${randomUUID()}`;
    for (const part of chunk([...domains], BATCH)) await this.Client.sadd(tmp, ...part);
    // A crash between the SADDs and the RENAME must not leave the temporary set forever.
    await this.Client.pexpire(tmp, TMP_TTL_MS);
    await this.Client.multi().rename(tmp, key).persist(key).sadd(INDEX, member(kind, source)).incr(VERSION).exec();
  }

  public async getMeta(key: string): Promise<string | null> {
    return this.Client.get(`meta:${key}`);
  }

  public async setMeta(key: string, value: string): Promise<void> {
    await this.Client.set(`meta:${key}`, value);
  }

  protected clientOptions(): RedisOptions {
    return { keyPrefix: 'ev:', ...this.RedisConfig };
  }

  protected createClient(): Redis {
    return new Redis(this.clientOptions());
  }
}
