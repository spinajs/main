import { readFileSync } from 'fs';
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand, ScanCommand, DescribeTableCommand, CreateTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DateTime } from 'luxon';

import { SessionProvider, UserSession, encodeSessionData, decodeSessionData, adaptLegacySession } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { principalKey } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
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

const isConditionFailure = (err: unknown) => (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

/**
 * DynamoDB-backed session store (AWS SDK v3), one item per session keyed by
 * `SessionId`.
 *
 * Item attributes: `Subject`, `ImpersonatorId` (principal keys), `State`,
 * `Creation` (ISO), `Expiration` (epoch ms, the TTL attribute), `Data` (the
 * session codec). An item without `Subject` was written by 2.x (numeric
 * `UserId`, identity in Data) and is adapted on every read.
 *
 * deleteBySubject / listBySubject run a strongly consistent Scan filtered on
 * Subject / ImpersonatorId plus every 2.x item, which is matched client side.
 * Liveness is always judged with `isExpired` in Node.
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
    let cfg: DynamoDBClientConfig = {};

    if (this.ConfigPath) {
      cfg = { ...cfg, ...JSON.parse(readFileSync(this.ConfigPath, 'utf-8')) };
    } else if (this.AwsConfig) {
      cfg = { ...cfg, ...this.AwsConfig };
    }

    this.DynamoDb = this.createClient(cfg);

    const table = await this.checkSessionTable();
    if (!table) {
      await this.createSessionTable();
      // A new table stays CREATING for a while; TTL can only be set once it is ACTIVE.
      await waitUntilTableExists({ client: this.DynamoDb, maxWaitTime: 120 }, { TableName: this.Table });
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

    const session = this.toSession(result.Item);

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
      item.Expiration = { N: `${session.Expiration.toMillis()}` };
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
   * exists, is live and is stored in the caller's State (SR-07). A 2.x item
   * has no State and is never written; the issuer migrates it first.
   */
  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    this.applyRenewedExpiration(session);

    const values: AttributeMap = {
      ':state': { S: session.State },
      ':now': { N: `${DateTime.now().toMillis()}` },
      ':data': { S: encodeSessionData(session.Data) },
    };
    let update = 'SET #data = :data REMOVE #exp';
    if (session.Expiration !== undefined) {
      values[':exp'] = { N: `${session.Expiration.toMillis()}` };
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

  public async delete(sessionId: string): Promise<void> {
    await this.DynamoDb.send(
      new DeleteItemCommand({
        TableName: this.Table,
        Key: { SessionId: { S: sessionId } },
      }),
    );
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

  /** Items of the subject, expired ones included: 3.0 items by their attributes, 2.x items (no Subject) by their Data. */
  protected async matching(subject: IdentityRef, includeImpersonations?: boolean): Promise<ISession[]> {
    const names: Record<string, string> = { '#subject': 'Subject' };
    let filter = '#subject = :key OR attribute_not_exists(#subject)';
    if (includeImpersonations === true) {
      names['#impersonator'] = 'ImpersonatorId';
      filter = '#subject = :key OR #impersonator = :key OR attribute_not_exists(#subject)';
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
   * The 3.0 view of an item; null for a 2.x item without an owner. `lenient`
   * (revocation and listing): an item whose Data does not decode keeps the
   * owner its attributes give and an empty Data, so one bad item cannot make
   * a revokeAll throw for everybody; a 2.x item then has no owner.
   */
  protected toSession(item: AttributeMap, lenient = false): ISession | null {
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

    const session = new UserSession({
      SessionId: item.SessionId.S!,
      Creation: DateTime.fromISO(item.Creation?.S ?? ''),
      Expiration: item.Expiration ? this.instant(item.Expiration) : undefined,
      Data: data,
    });

    const subject = refOf(item.Subject?.S);
    if (!subject) {
      return adaptLegacySession(session);
    }

    session.Subject = subject;
    session.Impersonator = refOf(item.ImpersonatorId?.S);
    session.State = item.State?.S === 'active' ? 'active' : 'pending';
    return session;
  }

  /** An Expiration that is not an epoch-ms number counts as already passed. */
  protected instant(value: AttributeValue): DateTime {
    const ms = value.N !== undefined ? Number(value.N) : NaN;
    return DateTime.fromMillis(Number.isFinite(ms) ? ms : 0);
  }

  protected expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
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
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }

      throw err;
    }
  }
}
