/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { FrameworkConfiguration } from '@spinajs/configuration';
import { OrmDriver, IColumnDescriptor } from '@spinajs/orm';
import _ from 'lodash';

import { PostgresOrmDriver } from '../src/index.js';

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

/**
 * The real driver with the database taken out: resolve() registers the full postgres
 * dialect into the connection container, and every query can be compiled and inspected
 * without a server. The suites that DO need a server live in test/integration.
 */
export class FakePostgresDriver extends PostgresOrmDriver {
  public executed: { stmt: string; params: any[] }[] = [];

  public async executeOnDb(stmt: string, params: any[], _context: any): Promise<any> {
    this.executed.push({ stmt, params });
    return [];
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public tableInfo(_table: string, _schema?: string): Promise<IColumnDescriptor[]> {
    return null as any;
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
            },
          ],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          Connections: [
            {
              Driver: 'postgres',
              Name: 'postgres',
              Host: 'localhost',
              Port: 15432,
              User: 'postgres',
              Password: 'postgres',
              Database: 'test',
            },
          ],
        },
      },
      mergeArrays,
    );
  }
}
