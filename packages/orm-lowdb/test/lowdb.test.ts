/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { LowDBDriver } from '../src/index.js';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { dir, mergeArrays } from './util.js';
import '@spinajs/log';
import { User } from './models/User.js';
import { DateTime } from 'luxon';

const expect = chai.expect;
chai.use(chaiAsPromised);

export const TEST_MIGRATION_TABLE_NAME = 'orm_migrations';

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
              type: 'ConsoleTarget',
              layout: '{datetime} {level} {message} {error} duration: {duration} ms ({logger})',
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
              Driver: 'orm-driver-lowdb',
              Filename: dir('lowdb.json'),
              Name: 'lowdb',
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

describe('Sqlite driver migration, updates, deletions & inserts', function () {
  this.timeout(10000);
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(LowDBDriver).as('orm-driver-lowdb');
    await DI.resolve(Orm);
  });

  it('should select', async () => {
    const result = await db().Connections.get('lowdb').select().from('users').where('Id', 1).first();

    expect(result).to.be.not.null;
    expect(result).to.deep.eq({
      Id: 1,
      Name: 'spinajs',
      Password: 'elemele',
      CreatedAt: '2023-10-05T14:48:00.000Z',
    });
  });

  it('Should select multiple conditions', async () => {
    const result = await db().Connections.get('lowdb').select().from('users').where('Id', 1).where('Name', 'spinajs').first();

    expect(result).to.be.not.null;
    expect(result).to.deep.eq({
      Id: 1,
      Name: 'spinajs',
      Password: 'elemele',
      CreatedAt: '2023-10-05T14:48:00.000Z',
    });
  });

  it('Select should return null', async () => {
    const result = await db().Connections.get('lowdb').select().from('users').where('Id', 1).where('Name', 'spinsssajs').first();
    expect(result).to.be.undefined;
  });

  it('Should select via model functions', async () => {
    const result = await User.where({
      Id: 1,
    }).first();

    expect(result).to.be.not.null;
    expect(result).to.be.instanceOf(User);
    expect(result.Id).to.eq(1);
  });

  it('should insert', async () => {
    await db().Connections.get('lowdb').insert().into('users').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });
  });

  it('should insert by model', async () => {
    const m = new User({
      Id: 111,
      Password: 'test',
      CreatedAt: DateTime.now(),
    });

    await m.insert();
  });

  it('should delete', async () => {});
  it('should delete by model', async () => {});

  it('should update', async () => {});
  it('should update by model', async () => {});
});
