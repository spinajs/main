import * as AWS from 'aws-sdk';
import { DateTime } from 'luxon';
import * as fs from 'fs';

import { SessionProvider, Session, ISession } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { reviver, replacer } from '@spinajs/util';
import { UnexpectedServerError } from '@spinajs/exceptions';

@Injectable(SessionProvider)
export class DynamoDbSessionProvider extends SessionProvider {
  @Logger('dynamo-session-store')
  protected Log: Log;

  @Config('rbac.session.aws.region')
  protected Region: string;

  @Config('rbac.session.aws.table')
  protected Table: string;

  @Config('rbac.session.aws.config')
  protected ConfigFile: string;

  protected DynamoDb: AWS.DynamoDB;

  // tslint:disable-next-line: no-empty
  public async resolveAsync() {
    if (!fs.existsSync(this.ConfigFile)) {
      throw new UnexpectedServerError(`AWS config file at ${this.ConfigFile} not exists`);
    }

    AWS.config.loadFromPath(this.ConfigFile);
    AWS.config.update({ region: this.Region });

    this.DynamoDb = new AWS.DynamoDB({ apiVersion: '2012-08-10' });
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
        }

        res(
          new Session({
            Creation: DateTime.fromISO(data.Item.Creation.S),
            Expiration: DateTime.fromISO(data.Item.Expiration.N),
            SessionId: data.Item.SessionId.S,
            Data: JSON.parse(data.Item.Data.S, reviver),
          }),
        );
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
          return;
        }
        res();
      });
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
