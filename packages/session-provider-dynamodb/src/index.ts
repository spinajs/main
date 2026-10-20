import { readFileSync } from 'fs';
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand, ScanCommand, DescribeTableCommand, DescribeTimeToLiveCommand, CreateTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DateTime } from 'luxon';

import { SessionProvider, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { principalKey } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn-session/register-schema';
import { Logger, Log } from '@spinajs/log';

type AttributeMap = Record<string, AttributeValue>;

interface IScanInput {
  FilterExpression?: string;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: AttributeMap;
}

const sameRef = (a: IdentityRef | undefined, b: IdentityRef) => !!a && a.type === b.type && a.id === b.id;

const belongsTo = (s: ISession, subject: IdentityRef, includeImpersonations?: boolean) => sameRef(s.Subject, subject) || (includeImpersonations === true && sameRef(s.Impersonator, subject));

/** Inverse of principalKey: the type ends at the first ':' and has ':' and '%' escaped. */
function refOf(key: unknown): IdentityRef | undefined {
  if (typeof key !== 'string') {
    return undefined;
  }
  const at = key.indexOf(':');
  if (at <= 0) {
    return undefined;
  }
  return { type: key.slice(0, at).replace(/%(25|3A)/g, (_, code: string) => (code === '25' ? '%' : ':')), id: key.slice(at + 1) };
}

/** Fractional seconds keep the millisecond precision the session round-trips. */
const toTtl = (d: DateTime) => `${d.toMillis() / 1000}`;

const isConditionFailure = (err: unknown) => (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

/**
 * DynamoDB-backed session store (AWS SDK v3), one item per session keyed by
 * `SessionId`.
 *
 * Item attributes: `Subject`, `ImpersonatorId` (principal keys), `State`,
 * `Creation` (ISO), `Expiration` (epoch seconds, the TTL attribute), `Data` (the
 * session codec).
 *
 * deleteBySubject / listBySubject run a strongly consistent Scan filtered on
 * Subject / ImpersonatorId. Liveness is always judged with `isExpired` in Node.
 */
@Injectable(SessionProvider)
export class DynamoDbSessionProvider extends SessionProvider {
  @Logger('dynamo-session-store')
  protected Log: Log;

  @Config('authn.session.aws.table')
  protected Table: string;

  @Config('authn.session.aws.config')
  protected AwsConfig: any;

  @Config('authn.session.aws.configPath')
  protected ConfigPath: any;

  @Config('authn.session.aws.readCapacityUnits', {
    defaultValue: 10,
  })
  protected ReadCapacityUnits: any;

  @Config('authn.session.aws.writeCapacityUnits', {
    defaultValue: 10,
  })
  protected WriteCapacityUnits: any;

  protected DynamoDb: DynamoDBClient;

  public async resolve() {
    // v3 has no global `AWS.config` / `loadFromPath`: region, endpoint and
    // credentials all go to the client constructor.
    if (typeof this.Table !== 'string' || this.Table.length === 0) {
      throw new Error('DynamoDbSessionProvider: config key authn.session.aws.table is required');
    }

    let cfg: DynamoDBClientConfig = {};

    if (this.AwsConfig) {
      cfg = { ...cfg, ...this.AwsConfig };
    }

    if (this.ConfigPath) {
      const file = JSON.parse(readFileSync(this.ConfigPath, 'utf-8'));
      // 2.x loadFromPath files keep credentials at the top level.
      const { accessKeyId, secretAccessKey, sessionToken, ...rest } = file;
      cfg = { ...cfg, ...rest };
      if (!cfg.credentials && accessKeyId && secretAccessKey) {
        cfg.credentials = { accessKeyId, secretAccessKey, sessionToken };
      }
    }

    this.DynamoDb = this.createClient(cfg);

    const table = await this.checkSessionTable();
    if (!table) {
      try {
        await this.createSessionTable();
      } catch (err) {
        // Another instance booting at the same time created it first.
        if ((err as { name?: string } | null)?.name !== 'ResourceInUseException') {
          throw err;
        }
      }
      // A new table stays CREATING for a while; TTL can only be set once it is ACTIVE.
      await waitUntilTableExists({ client: this.DynamoDb, maxWaitTime: 120 }, { TableName: this.Table });
      await this.updateTimeToLive();
    } else if (!(await this.isTimeToLiveEnabled())) {
      await this.updateTimeToLive();
    }
  }

  public async dispose() {
    this.DynamoDb?.destroy();
  }

  public async restore(sessionId: string): Promise<ISession | null> {
    const result = await this.DynamoDb.send(
      new GetItemCommand({
        TableName: this.Table,
        Key: { SessionId: { S: sessionId } },
        ConsistentRead: true,
      }),
    );

    if (!result.Item) {
      return null;
    }

    let session: ISession | null;
    try {
      session = this.toSession(result.Item);
    } catch (err) {
      this.Log.warn(`Session item ${sessionId} has undecodable Data: ${(err as Error).message}`);
      return null;
    }

    // TTL deletion is eventual: an expired item may still be there.
    if (!session || this.isExpired(session)) {
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    const item: AttributeMap = {
      SessionId: { S: session.SessionId },
      Subject: { S: principalKey(session.Subject) },
      State: { S: session.State },
      Creation: { S: session.Creation.toISO()! },
      Data: { S: encodeSessionData(session.Data) },
    };

    if (session.Impersonator) {
      item.ImpersonatorId = { S: principalKey(session.Impersonator) };
    }

    if (session.Expiration !== undefined) {
      item.Expiration = { N: toTtl(session.Expiration) };
    }

    await this.DynamoDb.send(
      new PutItemCommand({
        TableName: this.Table,
        Item: item,
      }),
    );
  }

  /**
   * One conditional UpdateItem of Expiration and Data: only an item that still
   * exists, is live and is stored in the caller's State (SR-07).
   */
  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    this.applyRenewedExpiration(session);

    const values: AttributeMap = {
      ':state': { S: session.State },
      ':now': { N: toTtl(DateTime.now()) },
      ':data': { S: encodeSessionData(session.Data) },
    };
    let update = 'SET #data = :data REMOVE #exp';
    if (session.Expiration !== undefined) {
      values[':exp'] = { N: toTtl(session.Expiration) };
      update = 'SET #exp = :exp, #data = :data';
    }

    try {
      await this.DynamoDb.send(
        new UpdateItemCommand({
          TableName: this.Table,
          Key: { SessionId: { S: session.SessionId } },
          UpdateExpression: update,
          ConditionExpression: 'attribute_exists(#id) AND #state = :state AND (attribute_not_exists(#exp) OR #exp > :now)',
          ExpressionAttributeNames: { '#id': 'SessionId', '#state': 'State', '#exp': 'Expiration', '#data': 'Data' },
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      session.Expiration = current;
      if (isConditionFailure(err)) {
        return false;
      }
      throw err;
    }

    return !this.expirationEquals(current, session.Expiration);
  }

  public async delete(sessionId: string): Promise<boolean> {
    const result = await this.DynamoDb.send(
      new DeleteItemCommand({
        TableName: this.Table,
        Key: { SessionId: { S: sessionId } },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return result.Attributes !== undefined;
  }

  /**
   * List-then-delete, repeated until a Scan finds no new item, so an item
   * saved during the call (a rotation racing a ban) also ends. Only items
   * live when read and still there when deleted count.
   */
  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    const seen = new Set<string>();
    let count = 0;

    for (;;) {
      const found = (await this.matching(subject, opts?.includeImpersonations)).filter((s) => s.SessionId !== opts?.except && !seen.has(s.SessionId));
      if (found.length === 0) {
        return count;
      }

      for (const session of found) {
        seen.add(session.SessionId);
        const result = await this.DynamoDb.send(
          new DeleteItemCommand({
            TableName: this.Table,
            Key: { SessionId: { S: session.SessionId } },
            ReturnValues: 'ALL_OLD',
          }),
        );
        if (result.Attributes && !this.isExpired(session)) {
          count++;
        }
      }
    }
  }

  public async listBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean }): Promise<ISession[]> {
    return (await this.matching(subject, opts?.includeImpersonations)).filter((s) => !this.isExpired(s));
  }

  /** Deletes every item and keeps the table: a deleted table stays DELETING for a while and cannot be recreated at once. */
  public async truncate(): Promise<void> {
    const items = await this.scan({ ProjectionExpression: '#id', ExpressionAttributeNames: { '#id': 'SessionId' } });
    for (const item of items) {
      await this.delete(item.SessionId.S!);
    }
  }

  protected createClient(cfg: DynamoDBClientConfig): DynamoDBClient {
    return new DynamoDBClient(cfg);
  }

  /** Items of the subject, expired ones included. */
  protected async matching(subject: IdentityRef, includeImpersonations?: boolean): Promise<ISession[]> {
    const names: Record<string, string> = { '#subject': 'Subject' };
    let filter = '#subject = :key';
    if (includeImpersonations === true) {
      names['#impersonator'] = 'ImpersonatorId';
      filter = '#subject = :key OR #impersonator = :key';
    }

    const items = await this.scan({ FilterExpression: filter, ExpressionAttributeNames: names, ExpressionAttributeValues: { ':key': { S: principalKey(subject) } } });
    return items.map((item) => this.toSession(item, true)).filter((s): s is ISession => !!s && belongsTo(s, subject, includeImpersonations));
  }

  /** Every page of a strongly consistent Scan. */
  protected async scan(input: IScanInput): Promise<AttributeMap[]> {
    const items: AttributeMap[] = [];
    let start: AttributeMap | undefined;
    do {
      const page = await this.DynamoDb.send(
        new ScanCommand({
          TableName: this.Table,
          ConsistentRead: true,
          ExclusiveStartKey: start,
          ...input,
        }),
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);

    return items;
  }

  /**
   * The session of an item; null for an item without a readable Subject.
   * `lenient` (revocation and listing): an item whose Data does not decode
   * keeps the owner its attributes give and an empty Data, so one bad item
   * cannot make a revokeAll throw.
   */
  protected toSession(item: AttributeMap, lenient = false): ISession | null {
    const subject = refOf(item.Subject?.S);
    if (!subject) {
      return null;
    }

    let data: Map<string, unknown>;
    try {
      data = decodeSessionData(item.Data?.S);
    } catch (err) {
      if (!lenient) {
        throw err;
      }
      this.Log.warn(`Session item with undecodable Data read without its Data`);
      data = new Map();
    }

    return new UserSession({
      SessionId: item.SessionId.S!,
      Subject: subject,
      Impersonator: refOf(item.ImpersonatorId?.S),
      State: item.State?.S === 'active' ? 'active' : 'pending',
      Creation: DateTime.fromISO(item.Creation?.S ?? ''),
      Expiration: item.Expiration ? this.instant(item.Expiration) : undefined,
      Data: data,
    });
  }

  /** An Expiration that is not a number counts as already passed. */
  protected instant(value: AttributeValue): DateTime {
    const n = value.N !== undefined ? Number(value.N) : NaN;
    if (!Number.isFinite(n)) {
      return DateTime.fromMillis(0);
    }
    return DateTime.fromMillis(Math.round(n * 1000));
  }

  protected expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }

  protected async isTimeToLiveEnabled(): Promise<boolean> {
    try {
      const res = await this.DynamoDb.send(new DescribeTimeToLiveCommand({ TableName: this.Table }));
      const status = res.TimeToLiveDescription?.TimeToLiveStatus;
      return status === 'ENABLED' || status === 'ENABLING';
    } catch (err) {
      this.Log.warn(`Cannot read TTL setting of ${this.Table}: ${(err as Error).message}`);
      return true;
    }
  }

  protected updateTimeToLive() {
    return this.DynamoDb.send(
      new UpdateTimeToLiveCommand({
        TableName: this.Table,
        TimeToLiveSpecification: {
          AttributeName: 'Expiration',
          Enabled: true,
        },
      }),
    );
  }

  protected createSessionTable() {
    return this.DynamoDb.send(
      new CreateTableCommand({
        TableName: this.Table,
        AttributeDefinitions: [
          {
            AttributeName: 'SessionId',
            AttributeType: 'S',
          },
        ],
        KeySchema: [
          {
            AttributeName: 'SessionId',
            KeyType: 'HASH',
          },
        ],
        ProvisionedThroughput: {
          ReadCapacityUnits: this.ReadCapacityUnits,
          WriteCapacityUnits: this.WriteCapacityUnits,
        },
      }),
    );
  }

  protected async checkSessionTable() {
    try {
      return await this.DynamoDb.send(
        new DescribeTableCommand({
          TableName: this.Table,
        }),
      );
    } catch (err) {
      // v3 names the error class in `err.name` (v2 used `err.code`).
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        return null;
      }

      throw err;
    }
  }
}
