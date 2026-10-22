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

// DynamoDB caps an item at 400 KB; the rest is headroom for the key and attribute names.
export const CHUNK_BYTES = 300_000;
export const INDEX_PK = 'S#index';
const VERSION_PK = 'M#listVersion';
const MAX_ATTEMPTS = 5;

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });
const isConditionFailure = (err: unknown) => (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
const sourcePk = (kind: ListKind, source: string) => `S#${kind}#${source}`;
const chunkPk = (kind: ListKind, source: string, gen: string, i: number) => `C#${kind}#${source}#${gen}#${i}`;
const notExists: Condition = { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } };
const equals = (name: string, value: AttributeValue): Condition => ({ ConditionExpression: '#a = :v', ExpressionAttributeNames: { '#a': name }, ExpressionAttributeValues: { ':v': value } });

export function chunkByBytes(domains: readonly string[], maxBytes: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const d of domains) {
    if (current.length > 0 && size + d.length + 1 > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(d);
    size += d.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * DynamoDB store (AWS SDK v3), one table with the string hash key `pk`. It uses no Scan.
 * Each list source is a manifest (`S#<kind>#<source>`: live `Gen`, `Chunks` count) over
 * chunk items of newline-joined domains, plus an index item of the live sources. A write
 * puts a new generation of chunks, compare-and-sets the manifest, then deletes the old
 * chunks. A reader that finds a chunk missing has raced a write, and reads the manifest again.
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
    const item = await this.get(`V#${verifier}#${domain}`);
    if (!item || Number(item.ExpiresAt.N) * 1000 <= Date.now()) return null;
    return JSON.parse(item.Verdict.S!) as CachedVerdict;
  }

  public async setVerdict(verifier: string, domain: string, verdict: CachedVerdict, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.put({ pk: s(`V#${verifier}#${domain}`), Verdict: s(JSON.stringify(verdict)), ExpiresAt: n((Date.now() + ttlSeconds * 1000) / 1000) });
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
      for (const domain of await this.readSource(kind, source)) entries.push({ domain, kind, source });
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
      const manifest = await this.get(sourcePk(kind, source));
      let current: string[] = [];
      if (manifest && readCurrent) {
        const read = await this.readChunks(kind, source, manifest);
        if (read === null) continue;
        current = read;
      }
      const chunks = chunkByBytes([...change(new Set(current))], CHUNK_BYTES);
      const gen = randomUUID();
      for (const [i, part] of chunks.entries()) await this.put({ pk: s(chunkPk(kind, source, gen, i)), Domains: s(part.join('\n')) });

      if (!(await this.swapManifest(kind, source, manifest, gen, chunks.length))) {
        await this.dropChunks(kind, source, gen, chunks.length);
        continue;
      }
      await this.updateIndex(`${kind}#${source}`, chunks.length > 0);
      await this.put({ pk: s(VERSION_PK), Value: s(randomUUID()) });
      if (manifest) await this.dropChunks(kind, source, manifest.Gen.S!, Number(manifest.Chunks.N));
      return;
    }
    throw new InvalidOperation(`email domain list ${kind}#${source} kept changing during ${MAX_ATTEMPTS} writes`);
  }

  protected async swapManifest(kind: ListKind, source: string, old: Item | undefined, gen: string, chunks: number): Promise<boolean> {
    try {
      if (chunks === 0) {
        if (old) await this.Client.send(new DeleteItemCommand({ TableName: this.Options.table, Key: { pk: s(sourcePk(kind, source)) }, ...equals('Gen', old.Gen) }));
        return true;
      }
      await this.put({ pk: s(sourcePk(kind, source)), Gen: s(gen), Chunks: n(chunks) }, old ? equals('Gen', old.Gen) : notExists);
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  protected async readSource(kind: ListKind, source: string): Promise<string[]> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const manifest = await this.get(sourcePk(kind, source));
      if (!manifest) return [];
      const domains = await this.readChunks(kind, source, manifest);
      if (domains !== null) return domains;
    }
    throw new InvalidOperation(`email domain list ${kind}#${source} kept changing during ${MAX_ATTEMPTS} reads`);
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

  protected async dropChunks(kind: ListKind, source: string, gen: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.Client.send(new DeleteItemCommand({ TableName: this.Options.table, Key: { pk: s(chunkPk(kind, source, gen, i)) } }));
    }
  }

  protected async indexMembers(): Promise<string[]> {
    const index = await this.get(INDEX_PK);
    return index ? (JSON.parse(index.Sources.S!) as string[]) : [];
  }

  protected async updateIndex(member: string, present: boolean): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const index = await this.get(INDEX_PK);
      const members = new Set<string>(index ? (JSON.parse(index.Sources.S!) as string[]) : []);
      if (members.has(member) === present) return;
      if (present) members.add(member);
      else members.delete(member);
      try {
        await this.put({ pk: s(INDEX_PK), Sources: s(JSON.stringify([...members].sort())), Ver: s(randomUUID()) }, index ? equals('Ver', index.Ver) : notExists);
        return;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
    }
    throw new InvalidOperation(`email domain list index kept changing during ${MAX_ATTEMPTS} writes`);
  }

  protected async get(pk: string): Promise<Item | undefined> {
    return (await this.Client.send(new GetItemCommand({ TableName: this.Options.table, Key: { pk: s(pk) }, ConsistentRead: true }))).Item;
  }

  protected async put(item: Item, condition?: Condition): Promise<void> {
    await this.Client.send(new PutItemCommand({ TableName: this.Options.table, Item: item, ...condition }));
  }

  protected async ensureTable(): Promise<void> {
    const TableName = this.Options.table;
    try {
      await this.Client.send(new DescribeTableCommand({ TableName }));
      const ttl = await this.Client.send(new DescribeTimeToLiveCommand({ TableName }));
      const status = ttl.TimeToLiveDescription?.TimeToLiveStatus;
      if (status !== 'ENABLED' && status !== 'ENABLING') await this.enableTtl();
      return;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
    }
    try {
      await this.Client.send(
        new CreateTableCommand({
          TableName,
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      );
    } catch (err) {
      // Another instance booting at the same time created it first.
      if ((err as { name?: string }).name !== 'ResourceInUseException') throw err;
    }
    await waitUntilTableExists({ client: this.Client, maxWaitTime: 120 }, { TableName });
    await this.enableTtl();
  }

  protected async enableTtl(): Promise<void> {
    await this.Client.send(new UpdateTimeToLiveCommand({ TableName: this.Options.table, TimeToLiveSpecification: { AttributeName: 'ExpiresAt', Enabled: true } }));
  }
}
