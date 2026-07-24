import { readFileSync } from 'fs';
import {
  DynamoDBClient,
  DynamoDBClientConfig,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  ScanCommand,
  DescribeTableCommand,
  CreateTableCommand,
  UpdateTimeToLiveCommand,
  DeleteTableCommand,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { DateTime } from 'luxon';

import { SessionProvider, ISession, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

type AttributeMap = Record<string, AttributeValue>;

/**
 * DynamoDB-backed session store. Conforms to the `@spinajs/rbac`
 * `SessionProvider` contract: ownership is the numeric `UserId` (persisted as
 * its own top-level attribute), expiration is owned by the injected strategy
 * (`this.Expiration`) and persisted verbatim, and `Data` is (de)serialized with
 * the shared session codec. Uses the AWS SDK for JavaScript v3
 * (`new DynamoDBClient(...)` + command objects dispatched through `.send()`).
 */
@Injectable(SessionProvider)
export class DynamoDbSessionProvider extends SessionProvider {
  @Logger('dynamo-session-store')
  protected Log: Log;

  @Config('rbac.session.aws.table')
  protected Table: string;

  @Config('rbac.session.aws.config')
  protected AwsConfig: any;

  @Config('rbac.session.aws.configPath')
  protected ConfigPath: any;

  @Config('rbac.session.aws.readCapacityUnits', {
    defaultValue: 10,
  })
  protected ReadCapacityUnits: any;

  @Config('rbac.session.aws.writeCapacityUnits', {
    defaultValue: 10,
  })
  protected WriteCapacityUnits: any;

  protected DynamoDb: DynamoDBClient;

  public async resolve() {
    // v3 has no global `AWS.config` / `loadFromPath` — the whole configuration
    // (region, endpoint, credentials) is passed straight into the client
    // constructor. `configPath` is read here and merged in ourselves.
    let cfg: DynamoDBClientConfig = {};

    if (this.ConfigPath) {
      cfg = { ...cfg, ...JSON.parse(readFileSync(this.ConfigPath, 'utf-8')) };
    } else if (this.AwsConfig) {
      cfg = { ...cfg, ...this.AwsConfig };
    }

    this.DynamoDb = new DynamoDBClient(cfg);

    const table = await this.checkSessionTable();
    if (!table) {
      await this.createSessionTable();
      await this.updateTimeToLive();
    }
  }

  public async restore(sessionId: string): Promise<ISession | null> {
    const result = await this.DynamoDb.send(
      new GetItemCommand({
        TableName: this.Table,
        Key: {
          SessionId: { S: sessionId },
        },
      }),
    );

    if (!result.Item) {
      return null;
    }

    const session = this.toSession(result.Item);

    // DynamoDB TTL deletion is eventual — an expired item may still be present.
    // Treat an expired session as absent, matching the contract.
    if (this.isExpired(session)) {
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
    // Persist `Expiration` verbatim. Only a brand-new session with no scheduled
    // expiration is given its initial expiry via the strategy (fixes B3).
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    const item: AttributeMap = {
      SessionId: { S: session.SessionId },
      // ownership source of truth — a top-level numeric attribute (fixes B4).
      UserId: { N: `${session.UserId}` },
      Creation: { S: session.Creation.toISO()! },
      Data: { S: encodeSessionData(session.Data) },
    };

    // DynamoDB TTL attribute (epoch millis), driven by `session.Expiration`.
    // A never-expiring session simply omits it.
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

  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    const renewed = this.Expiration.renew(session);

    // unchanged (e.g. AbsoluteExpiration) — skip the write, report false
    if (this.expirationEquals(current, renewed)) {
      return false;
    }

    session.Expiration = renewed;
    await this.save(session);

    return true;
  }

  public async delete(sessionId: string): Promise<void> {
    await this.DynamoDb.send(
      new DeleteItemCommand({
        TableName: this.Table,
        Key: {
          SessionId: { S: sessionId },
        },
      }),
    );
  }

  public async deleteByUser(userId: number): Promise<void> {
    // DynamoDB has no filtered batch delete — scan by the top-level numeric
    // UserId attribute and delete each match (fixes B4; the old `logsOut`
    // filtered `Data.User` inside a scalar JSON string and matched nothing).
    const items = await this.scanByUser(userId);

    for (const item of items) {
      await this.delete(item.SessionId.S!);
    }
  }

  public async listByUser(userId: number): Promise<ISession[]> {
    const items = await this.scanByUser(userId);

    return items.map((item) => this.toSession(item)).filter((s) => !this.isExpired(s));
  }

  public async truncate(): Promise<void> {
    await this.deleteSessionTable();
    await this.createSessionTable();
    await this.updateTimeToLive();
  }

  protected async scanByUser(userId: number): Promise<AttributeMap[]> {
    const result = await this.DynamoDb.send(
      new ScanCommand({
        TableName: this.Table,
        FilterExpression: 'UserId = :uid',
        ExpressionAttributeValues: {
          ':uid': { N: `${userId}` },
        },
      }),
    );

    return result.Items ?? [];
  }

  protected toSession(item: AttributeMap): ISession {
    return new UserSession({
      SessionId: item.SessionId.S!,
      UserId: item.UserId ? parseInt(item.UserId.N!, 10) : 0,
      Creation: DateTime.fromISO(item.Creation.S!),
      Expiration: item.Expiration ? DateTime.fromMillis(parseInt(item.Expiration.N!, 10)) : undefined,
      Data: decodeSessionData(item.Data.S!),
    });
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
      // v3 surfaces the error class name via `err.name` (v2 used `err.code`).
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }

      throw err;
    }
  }

  protected async deleteSessionTable() {
    await this.DynamoDb.send(
      new DeleteTableCommand({
        TableName: this.Table,
      }),
    );
  }
}
