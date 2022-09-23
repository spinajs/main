import * as AWS from 'aws-sdk';
import { DateTime } from 'luxon';

import { SessionProvider, Session, ISession } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { reviver, replacer } from '@spinajs/util';

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

  @Config('rbac.session.aws.readCapacityUnits', 10)
  protected ReadCapacityUnits: any;

  @Config('rbac.session.aws.writeCapacityUnits', 10)
  protected WriteCapacityUnits: any;

  protected DynamoDb: AWS.DynamoDB;

  // tslint:disable-next-line: no-empty
  public async resolve() {
    AWS.config.update(this.AwsConfig);

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
    }
  }

  public async restore(sessionId: string): Promise<Session> {
    const params = {
      TableName: this.Table,
      Key: {
        SessionId: { S: sessionId },
      },
    };

    const result = await this.DynamoDb.getItem(params).promise();

    if (!result.Item) {
      return null;
    } else {
      // DynamoDB ttl takes time, sometimes
      // we receive session before ttl mark result as expired
      // and deletes it
      const ttl = parseInt(result.Item.Expiration.N);
      if (ttl < DateTime.now().toMillis()) {
        return null;
      }

      return new Session({
        Creation: DateTime.fromISO(result.Item.Creation.S),
        Expiration: DateTime.fromMillis(ttl),
        SessionId: result.Item.SessionId.S,
        Data: JSON.parse(result.Item.Data.S, reviver),
      });
    }
  }

  public async delete(sessionId: string): Promise<void> {
    const params = {
      TableName: this.Table,
      Key: {
        SessionId: { S: sessionId },
      },
    };

    await this.DynamoDb.deleteItem(params).promise();
  }

  public async ouch(session: ISession) {
    const params = {
      TableName: this.Table,
      Key: {
        SessionId: { S: session.SessionId },
      },
      UpdateExpression: 'set Expiration = :e',
      ExpressionAttributeValues: {
        ':e': {
          N: `${session.Expiration.toMillis()}`,
        },
      },
      ReturnValues: 'UPDATED_NEW',
    };

    await this.DynamoDb.updateItem(params).promise();
  }

  public async truncate(): Promise<void> {
    await this.deleteSessionTable();
    await this.createSessionTable();
    await this.updateTimeToLive();
  }

  protected async deleteSessionTable() {
    await this.DynamoDb.deleteTable({
      TableName: this.Table,
    }).promise();
  }

  public async save(session: ISession): Promise<void> {
    const params = {
      TableName: this.Table,
      Item: {
        SessionId: { S: session.SessionId },
        Data: {
          S: JSON.stringify(session.Data, replacer),
        },
        Creation: { S: session.Creation.toISO() },
        Expiration: { N: `${session.Expiration.toMillis()}` },
      },
    };

    await this.DynamoDb.putItem(params).promise();
  }
}
