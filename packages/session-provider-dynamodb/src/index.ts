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
  public async resolveAsync() {
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
    return new Promise<void>((resolve, reject) => {
      this.DynamoDb.updateTimeToLive(
        {
          TableName: this.Table,
          TimeToLiveSpecification: {
            AttributeName: 'Expiration',
            Enabled: true,
          },
        },
        (err: AWS.AWSError) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  }

  protected createSessionTable() {
    return new Promise((resolve, reject) => {
      this.DynamoDb.createTable(
        {
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
        },
        (err: AWS.AWSError, data: AWS.DynamoDB.CreateTableOutput) => {
          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        },
      );
    });
  }

  protected checkSessionTable() {
    return new Promise((resolve, reject) => {
      this.DynamoDb.describeTable(
        {
          TableName: this.Table,
        },
        (err: AWS.AWSError, data: AWS.DynamoDB.DescribeTableOutput) => {
          if (err) {
            if (err.code === 'ResourceNotFoundException') {
              resolve(null);
            } else {
              reject(err);
            }
          } else {
            resolve(data);
          }
        },
      );
    });
  }

  public async restore(sessionId: string): Promise<Session> {
    const params = {
      TableName: this.Table,
      Key: {
        SessionId: { S: sessionId },
      },
    };

    const session = await new Promise<Session>((res, rej) => {
      this.DynamoDb.getItem(params, (err: any, data: any) => {
        if (err) {
          rej(err);
          return;
        }

        if (!data.Item) {
          res(null);
        } else {
          // DynamoDB ttl takes time, sometimes
          // we receive session before ttl mark result as expired
          // and deletes it
          const ttl = parseInt(data.Item.Expiration.N);
          if (ttl < DateTime.now().toMillis()) {
            res(null);
          }

          res(
            new Session({
              Creation: DateTime.fromISO(data.Item.Creation.S),
              Expiration: DateTime.fromMillis(ttl),
              SessionId: data.Item.SessionId.S,
              Data: JSON.parse(data.Item.Data.S, reviver),
            }),
          );
        }
      });
    });

    if (!session) {
      return null;
    }

    return session;
  }

  public async delete(sessionId: string): Promise<void> {
    const params = {
      TableName: this.Table,
      Key: {
        SessionId: { S: sessionId },
      },
    };

    await new Promise<void>((res, rej) => {
      this.DynamoDb.deleteItem(params, (err: any) => {
        if (err) {
          rej(err);
        } else {
          res();
        }
      });
    });
  }

  public touch(session: ISession): Promise<void> {
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

    return new Promise((resolve, reject) => {
      this.DynamoDb.updateItem(params, (err: AWS.AWSError) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  public async truncate(): Promise<void> {
    await this.deleteSessionTable();
    await this.createSessionTable();
    await this.updateTimeToLive();
  }

  protected deleteSessionTable(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.DynamoDb.deleteTable(
        {
          TableName: this.Table,
        },
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
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

    await new Promise<void>((res, rej) => {
      this.DynamoDb.putItem(params, (err: any) => {
        if (err) {
          rej(err);
          return;
        }
        res();
      });
    });
  }
}
