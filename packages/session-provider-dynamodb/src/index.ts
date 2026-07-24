import AWS from 'aws-sdk';
import { DateTime } from 'luxon';

import { SessionProvider, ISession, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

/**
 * DynamoDB-backed session store. Conforms to the `@spinajs/rbac`
 * `SessionProvider` contract: ownership is the numeric `UserId` (persisted as
 * its own top-level attribute), expiration is owned by the injected strategy
 * (`this.Expiration`) and persisted verbatim, and `Data` is (de)serialized with
 * the shared session codec. Stays on `aws-sdk` v2 (`new AWS.DynamoDB(...)` +
 * `.promise()`).
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

  protected DynamoDb: AWS.DynamoDB;

  public async resolve() {
    if (this.ConfigPath) {
      AWS.config.loadFromPath(this.ConfigPath);
    } else if (this.AwsConfig) {
      AWS.config.update(this.AwsConfig);
    }

    this.DynamoDb = new AWS.DynamoDB({ apiVersion: '2012-08-10' });

    const table = await this.checkSessionTable();
    if (!table) {
      await this.createSessionTable();
      await this.updateTimeToLive();
    }
  }

  public async restore(sessionId: string): Promise<ISession | null> {
    const result = await this.DynamoDb.getItem({
      TableName: this.Table,
      Key: {
        SessionId: { S: sessionId },
      },
    }).promise();

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

    const item: AWS.DynamoDB.PutItemInputAttributeMap = {
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

    await this.DynamoDb.putItem({
      TableName: this.Table,
      Item: item,
    }).promise();
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
    await this.DynamoDb.deleteItem({
      TableName: this.Table,
      Key: {
        SessionId: { S: sessionId },
      },
    }).promise();
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

  protected async scanByUser(userId: number): Promise<AWS.DynamoDB.AttributeMap[]> {
    const result = await this.DynamoDb.scan({
      TableName: this.Table,
      FilterExpression: 'UserId = :uid',
      ExpressionAttributeValues: {
        ':uid': { N: `${userId}` },
      },
    }).promise();

    return result.Items ?? [];
  }

  protected toSession(item: AWS.DynamoDB.AttributeMap): ISession {
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
    return this.DynamoDb.updateTimeToLive({
      TableName: this.Table,
      TimeToLiveSpecification: {
        AttributeName: 'Expiration',
        Enabled: true,
      },
    }).promise();
  }

  protected createSessionTable() {
    return this.DynamoDb.createTable({
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
    }).promise();
  }

  protected async checkSessionTable() {
    try {
      return await this.DynamoDb.describeTable({
        TableName: this.Table,
      }).promise();
    } catch (err) {
      if (err.code === 'ResourceNotFoundException') {
        return null;
      }

      throw err;
    }
  }

  protected async deleteSessionTable() {
    await this.DynamoDb.deleteTable({
      TableName: this.Table,
    }).promise();
  }
}
