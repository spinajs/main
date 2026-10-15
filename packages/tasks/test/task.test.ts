import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';

import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { QueueService } from '@spinajs/queue';
import { TestTask } from './Tasks/TestTask.js';
import { __task, __task_history } from '../src/index.js';
import '@spinajs/orm-sqlite';
import { TestTask2 } from './Tasks/TestTask2.js';
import { Mutex, mutex_acquire, mutex_get } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';
import { TestTaskNoOptions } from './Tasks/TestTaskNoOptions.js';
import { TestTaskFailing } from './Tasks/TestTaskFailing.js';

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
      queue: {
        routing: {
          // task module events - inform when task fails or succeeds
          TaskFailed: { connection: 'task-empty-queue' },
          TaskSuccess: { connection: 'task-empty-queue' },
        },

        // by default all events from rbac module are routed to rbac-user-empty-queue
        // and is using empty sink ( no events are sent )
        connections: [
          {
            name: 'task-empty-queue',
            service: 'BlackHoleQueueClient',
            defaultQueueChannel: 'task-jobs',
            defaultTopicChannel: 'task-events',
          },
        ],
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Commands', function () {
  this.timeout(20000);

  beforeEach(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(OrmMutex).as(Mutex);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(QueueService);
  });

  it('Should save task run data to db', async () => {
    const task = new TestTask();
    await task.execute(1);
    await task.execute(1);
    await task.execute(1);

    const t = await __task.all();
    const tHistory = await __task_history.all();

    expect(t.length).to.equal(1);
    expect(tHistory.length).to.equal(3);
  });

  it('Should not run task function if already running', async () => {
    const task = new TestTask2();
    for (let i = 0; i < 5; i++) {
      task.execute(1);
      await sleep(100);
    }

    await sleep(2000);

    const t = await __task.all();
    const tHistory = await __task_history.all();

    expect(t.length).to.equal(1);
    expect(tHistory.length).to.equal(1);
  });

  it('Should save error when task function fails', async () => {});

  it('Should emit succeed event to queue', async () => {});
  describe('mutex', () => {
    it('Should release the task mutex after a run', async () => {
      await new TestTask().execute(1);

      const m = await mutex_get('task-TestTask');
      expect(m).to.not.be.undefined;
      expect(m!.Locked).to.be.false;
    });

    it('Should release the task mutex when the task throws', async () => {
      await new TestTaskFailing().execute();

      const m = await mutex_get('task-TestTaskFailing');
      expect(m!.Locked).to.be.false;
    });

    it('Should run a task declared without options', async () => {
      await new TestTaskNoOptions().execute();

      expect(await __task_history.all()).to.have.length(1);
      expect((await mutex_get('task-TestTaskNoOptions'))!.Locked).to.be.false;
    });

    it('Should skip the run while another process holds the task mutex', async () => {
      await mutex_acquire({ Name: 'task-TestTask', Tenant: 'other-replica' });

      await new TestTask().execute(1);

      expect(await __task_history.all()).to.have.length(0);
    });
  });
});
