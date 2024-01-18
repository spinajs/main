/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, MigrationTransactionMode } from '@spinajs/orm';
import _ from 'lodash';
import { mergeArrays } from './util.js';
import '@spinajs/log';

export const TEST_MIGRATION_TABLE_NAME = 'orm_migrations';

export class ConnectionConf2 extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'ConsoleTarget',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          Migration: {
            Startup: false,
          },
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                Table: TEST_MIGRATION_TABLE_NAME,

                Transaction: {
                  Mode: MigrationTransactionMode.PerMigration,
                },
              },
            },
          ],
        },
      },
      mergeArrays,
    );
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
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                Table: TEST_MIGRATION_TABLE_NAME,
              },
            },
          ],
        },
      },
      mergeArrays,
    );
  }
}

export function db() {
  return DI.get(Orm);
}
