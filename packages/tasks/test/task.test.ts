import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { spy } from 'sinon';
import { expect } from 'chai';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';

import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { QueueService } from '@spinajs/queue';
import { TestTask } from './Tasks/TestTask.js';
import { __task, __task_history } from '../src/index.js';
import "@spinajs/orm-sqlite";

//const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'ConsoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} (${logger})',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          // queue DB
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'queue',
            Migration: {
              OnStartup: true,
              Table: 'orm_migrations',
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },

          {
            Debug: {
              Queries: true,
            },
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: {
              Table: 'orm_migrations',
              OnStartup: true,
            },
          },
        ],
      },
    };
  }
}

describe('Commands', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(QueueService);
  });

  it('Should save task run data to db', async () => {
    const execute = spy(TestTask.prototype, 'execute');

    const task = new TestTask();
    await task.execute(1);
    await task.execute(1);
    await task.execute(1);

    const t = await __task.all();
    const tHistory = await __task_history.all();

    expect(execute.calledOnce).to.be.true;
    expect(t.length).to.equal(1);
    expect(tHistory.length).to.equal(3);
  });

  it('Should not run task function if already running', async () =>{ 

  });

  it('Should save error when task function fails', async () =>{ 

  });

  it('Should emit succeed event to queue', async () =>{ 

  });
});
