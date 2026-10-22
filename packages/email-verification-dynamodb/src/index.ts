import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteItemCommand, DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, GetItemCommand, PutItemCommand, UpdateTimeToLiveCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { EmailVerificationStore } from '@spinajs/email-verification';
import type { CachedVerdict, DynamoDbStoreOptions, ListEntry, ListKind } from '@spinajs/email-verification';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';

type Item = Record<string, AttributeValue>;

interface Condition {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Item;
}

interface Generation {
  gen: string;
  chunks: number;
}

// DynamoDB caps an item at 400 KB; the rest is headroom for the key and attribute names.
export const CHUNK_BYTES = 300_000;
export const INDEX_PK = 'S#index';
const VERSION_PK = 'L#version';
const TTL_ATTRIBUTE = 'ExpiresAt';
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 20;

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorName = (err: unknown) => (err as { name?: string } | null)?.name;
const isConditionFailure = (err: unknown) => errorName(err) === 'ConditionalCheckFailedException';
const sourcePk = (kind: ListKind, source: string) => `S#${kind}#${source}`;
const chunkPk = (kind: ListKind, source: string, gen: string, i: number) => `C#${kind}#${source}#${gen}#${i}`;
const notExists: Condition = { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } };
const equals = (name: string, value: AttributeValue): Condition => ({ ConditionExpression: '#a = :v', ExpressionAttributeNames: { '#a': name }, ExpressionAttributeValues: { ':v': value } });

/** The live generation of a manifest and the one it replaced. */
const generationsOf = (manifest: Item): Generation[] => [{ gen: manifest.Gen.S!, chunks: Number(manifest.Chunks.N) }, ...(manifest.PrevGen ? [{ gen: manifest.PrevGen.S!, chunks: Number(manifest.PrevChunks.N) }] : [])];

export function chunkByBytes(domains: readonly string[], maxBytes: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const d of domains) {
    const bytes = Buffer.byteLength(d) + 1;
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(d);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * DynamoDB store (AWS SDK v3), one table with the string hash key `pk`. It uses no Scan.
 * Each list source is a manifest (`S#<kind>#<source>`: live `Gen` and `Chunks` count, the
 * replaced `PrevGen` and `PrevChunks`) over chunk items of newline-joined domains, plus an
 * index item of the sources. A write puts a new generation of chunks, compare-and-sets the
 * manifest, then deletes the replaced generation and the one before it, so the next write
 * reclaims what a writer that died after its swap left behind. An emptied source keeps a
 * manifest of zero chunks and its index member: removing either could race a writer
 * re-creating the source. A reader that finds a chunk missing has raced a write, and reads
 * the manifest again.
 */
@Injectable(EmailVerificationStore)
export class DynamoDbEmailVerificationStore extends EmailVerificationStore {
  @Config('emailVerification.dynamodb')
  protected Options: DynamoDbStoreOptions;

  @Logger('email-verification')
  protected Log: Log;

  protected Client: DynamoDBClient;

  public async resolve(): Promise<void> {
    this.Client = this.createClient(this.Options.config as DynamoDBClientConfig);
    if (this.Options.createTable) await this.ensureTable();
    await super.resolve();
  }

  public async dispose(): Promise<void> {
    this.Client?.destroy();
  }

  public async getVerdict(verifier: string, domain: string): Promise<CachedVerdict | null> {
    const item = await this.get(`V#${verifier}#${domain}`, false);
    if (!item || Number(item.ExpiresAt.N) * 1000 <= Date.now()) return null;
    return JSON.parse(item.Verdict.S!) as CachedVerdict;
  }

  public async setVerdict(verifier: string, domain: string, verdict: CachedVerdict, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.put({ pk: s(`V#${verifier}#${domain}`), Verdict: s(JSON.stringify(verdict)), ExpiresAt: n(Math.floor((Date.now() + ttlSeconds * 1000) / 1000)) });
  }

  public async getMeta(key: string): Promise<string | null> {
    return (await this.get(`M#${key}`))?.Value?.S ?? null;
  }

  public async setMeta(key: string, value: string): Promise<void> {
    await this.put({ pk: s(`M#${key}`), Value: s(value) });
  }

  public async listVersion(): Promise<string> {
    return (await this.get(VERSION_PK))?.Value?.S ?? '0';
  }

  public async loadLists(): Promise<ListEntry[]> {
    const entries: ListEntry[] = [];
    for (const m of await this.indexMembers()) {
      const at = m.indexOf('#');
      const kind = m.slice(0, at) as ListKind;
      const source = m.slice(at + 1);
      const domains = await this.readSource(kind, source);
      if (domains === null) {
        this.Log.warn(`Email domain list ${kind}#${source} stayed unreadable through ${MAX_ATTEMPTS} reads; skipped`);
        continue;
      }
      for (const domain of domains) entries.push({ domain, kind, source });
    }
    return entries;
  }

  public async upsertEntries(entries: readonly ListEntry[]): Promise<void> {
    const groups = new Map<string, { kind: ListKind; source: string; domains: string[] }>();
    for (const e of entries) {
      const key = `${e.kind}#${e.source}`;
      const group = groups.get(key) ?? { kind: e.kind, source: e.source, domains: [] };
      group.domains.push(e.domain);
      groups.set(key, group);
    }
    for (const g of groups.values()) await this.mutateSource(g.kind, g.source, (current) => new Set([...current, ...g.domains]));
  }

  public async removeEntries(kind: ListKind, domains: readonly string[], source: string): Promise<void> {
    await this.mutateSource(kind, source, (current) => {
      domains.forEach((d) => current.delete(d));
      return current;
    });
  }

  public async replaceSource(source: string, kind: ListKind, domains: readonly string[]): Promise<void> {
    await this.mutateSource(kind, source, () => new Set(domains), false);
  }

  protected createClient(cfg: DynamoDBClientConfig): DynamoDBClient {
    return new DynamoDBClient(cfg);
  }

  protected async mutateSource(kind: ListKind, source: string, change: (current: Set<string>) => Set<string>, readCurrent = true): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS * attempt);
      const manifest = await this.get(sourcePk(kind, source));
      let current: string[] = [];
      if (manifest && readCurrent) {
        const read = await this.readChunks(kind, source, manifest);
        if (read === null) continue;
        current = read;
      }
      const chunks = chunkByBytes([...change(new Set(current))], CHUNK_BYTES);
      const gen = randomUUID();
      await this.putChunks(kind, source, gen, chunks);
      if (!(await this.swapManifest(kind, source, manifest, gen, chunks.length))) {
        await this.dropGenerations(kind, source, [{ gen, chunks: chunks.length }]);
        continue;
      }
      await this.settleSwap(kind, source, manifest, chunks.length > 0);
      return;
    }
    throw new InvalidOperation(`email domain list ${kind}#${source} kept changing during ${MAX_ATTEMPTS} writes`);
  }

  // A crash during these puts leaks the generation: no manifest names it yet.
  protected async putChunks(kind: ListKind, source: string, gen: string, chunks: string[][]): Promise<void> {
    for (const [i, part] of chunks.entries()) {
      try {
        await this.put({ pk: s(chunkPk(kind, source, gen, i)), Domains: s(part.join('\n')) });
      } catch (err) {
        await this.dropGenerations(kind, source, [{ gen, chunks: i + 1 }]);
        throw err;
      }
    }
  }

  /**
   * true when the manifest now names `gen` (or named it before a later writer replaced it).
   * A failure with an unknown outcome is rethrown and keeps the chunks, as the put may still land.
   */
  protected async swapManifest(kind: ListKind, source: string, old: Item | undefined, gen: string, chunks: number): Promise<boolean> {
    if (!old && chunks === 0) return true;
    const item: Item = { pk: s(sourcePk(kind, source)), Gen: s(gen), Chunks: n(chunks), ...(old ? { PrevGen: old.Gen, PrevChunks: old.Chunks } : {}) };
    try {
      await this.put(item, old ? equals('Gen', old.Gen) : notExists);
      return true;
    } catch (err) {
      // The put can commit while the client sees an error, e.g. a retry failing on the put's own effect.
      const now = await this.get(sourcePk(kind, source));
      if (now?.Gen.S === gen || now?.PrevGen?.S === gen) return true;
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** Runs every step even when one fails, then rethrows the first failure. */
  protected async settleSwap(kind: ListKind, source: string, replaced: Item | undefined, live: boolean): Promise<void> {
    const failures: unknown[] = [];
    // The index goes first: an instance that sees the new version must find the source in it.
    if (live) await this.addToIndex(`${kind}#${source}`).catch((err: unknown) => failures.push(err));
    await this.put({ pk: s(VERSION_PK), Value: s(randomUUID()) }).catch((err: unknown) => failures.push(err));
    if (replaced) await this.dropGenerations(kind, source, generationsOf(replaced));
    if (failures.length > 0) throw failures[0];
  }

  /** null when the source stayed unreadable through every retry. */
  protected async readSource(kind: ListKind, source: string): Promise<string[] | null> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS * attempt);
      const manifest = await this.get(sourcePk(kind, source));
      if (!manifest) return [];
      const domains = await this.readChunks(kind, source, manifest);
      if (domains !== null) return domains;
    }
    return null;
  }

  /** null when a chunk is gone: a writer replaced this generation during the read. */
  protected async readChunks(kind: ListKind, source: string, manifest: Item): Promise<string[] | null> {
    const domains: string[] = [];
    for (let i = 0; i < Number(manifest.Chunks.N); i++) {
      const chunk = await this.get(chunkPk(kind, source, manifest.Gen.S!, i));
      if (!chunk) return null;
      domains.push(...chunk.Domains.S!.split('\n'));
    }
    return domains;
  }

  /** Best effort: a generation left behind here is reclaimed by a later write to the source. */
  protected async dropGenerations(kind: ListKind, source: string, generations: Generation[]): Promise<void> {
    for (const { gen, chunks } of generations) {
      try {
        for (let i = 0; i < chunks; i++) {
          await this.Client.send(new DeleteItemCommand({ TableName: this.Options.table, Key: { pk: s(chunkPk(kind, source, gen, i)) } }));
        }
      } catch (err) {
        this.Log.warn(err as Error, `Could not drop generation ${gen} of email domain list ${kind}#${source}`);
      }
    }
  }

  protected async indexMembers(): Promise<string[]> {
    const index = await this.get(INDEX_PK);
    return index ? (JSON.parse(index.Sources.S!) as string[]) : [];
  }

  protected async addToIndex(member: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS * attempt);
      const index = await this.get(INDEX_PK);
      const members = new Set<string>(index ? (JSON.parse(index.Sources.S!) as string[]) : []);
      if (members.has(member)) return;
      members.add(member);
      try {
        await this.put({ pk: s(INDEX_PK), Sources: s(JSON.stringify([...members].sort())), Ver: s(randomUUID()) }, index ? equals('Ver', index.Ver) : notExists);
        return;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
    }
    throw new InvalidOperation(`email domain list index kept changing during ${MAX_ATTEMPTS} writes`);
  }

  protected async get(pk: string, consistent = true): Promise<Item | undefined> {
    return (await this.Client.send(new GetItemCommand({ TableName: this.Options.table, Key: { pk: s(pk) }, ConsistentRead: consistent }))).Item;
  }

  protected async put(item: Item, condition?: Condition): Promise<void> {
    await this.Client.send(new PutItemCommand({ TableName: this.Options.table, Item: item, ...condition }));
  }

  protected async ensureTable(): Promise<void> {
    const TableName = this.Options.table;
    try {
      await this.Client.send(new DescribeTableCommand({ TableName }));
    } catch (err) {
      if (errorName(err) !== 'ResourceNotFoundException') throw err;
      await this.createTable();
    }
    await waitUntilTableExists({ client: this.Client, maxWaitTime: 120 }, { TableName });
    const ttl = (await this.Client.send(new DescribeTimeToLiveCommand({ TableName }))).TimeToLiveDescription;
    if (ttl?.TimeToLiveStatus === 'ENABLED' || ttl?.TimeToLiveStatus === 'ENABLING') {
      if (ttl.AttributeName !== TTL_ATTRIBUTE) this.Log.warn(`Table ${TableName} expires items by ${ttl.AttributeName}, not ${TTL_ATTRIBUTE}: expired verdicts stay in the table`);
      return;
    }
    await this.enableTtl();
  }

  protected async createTable(): Promise<void> {
    try {
      await this.Client.send(
        new CreateTableCommand({
          TableName: this.Options.table,
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      );
    } catch (err) {
      // Another instance booting at the same time created it first.
      if (errorName(err) !== 'ResourceInUseException') throw err;
    }
  }

  protected async enableTtl(): Promise<void> {
    try {
      await this.Client.send(new UpdateTimeToLiveCommand({ TableName: this.Options.table, TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true } }));
    } catch (err) {
      // Another instance booting at the same time enabled it first.
      if (errorName(err) !== 'ValidationException' || !/already enabled/i.test((err as Error).message)) throw err;
    }
  }
}
