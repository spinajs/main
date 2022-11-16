var Module = require('module');
var originalRequire = Module.prototype.require;

Module.prototype.require = function () {
  //do your thing here
  return originalRequire.apply(this, arguments);
};

import { QueueBootstrapper } from '@spinajs/queue/src/bootstrap';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import '../src';
import servers from './config';
import { EmailService } from '../src';
import '@spinajs/templates-handlebars';
import '@spinajs/templates-pug';
import '@spinajs/queue-stomp-transport';
import '@spinajs/email-smtp-transport';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { QueueService } from '@spinajs/queue';
import * as sinon from 'sinon';

chai.use(chaiAsPromised);

const TestEventChannelName = `/topic/test-${DateTime.now().toMillis()}`;
const TestJobChannelName = `/queue/test-${DateTime.now().toMillis()}`;

export class ConnectionConf extends FrameworkConfiguration {
  async resolve() {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        system: {
          dirs: {
            templates: [dir('./templates')],
            locales: [dir('./locales')],
          },
        },
        email: {
          connections: servers,
        },
        queue: {
          default: 'default-test-queue',
          routing: {
            EmailSendJob: { connection: 'default-test-queue' },
            EmailSent: { connection: 'default-test-queue' },
          },
          connections: [
            {
              service: 'StompQueueClient',
              host: 'ws://localhost:61614/ws',
              name: `default-test-queue`,
              debug: true,
              defaultQueueChannel: TestJobChannelName,
              defaultTopicChannel: TestEventChannelName,
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

            // default connection
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                OnStartup: true,
                Table: 'orm_migrations',
                Transaction: {
                  Mode: MigrationTransactionMode.PerMigration,
                },
              },
            },
          ],
        },
        fs: {
          default: 'fs-local',
          providers: [
            {
              service: 'fsNative',
              name: 'fs-local',
              basePath: dir('./files'),
            },
          ],
        },
        intl: {
          defaultLocale: 'pl',

          // supported locales
          locales: ['en'],
        },
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
      },
      mergeArrays,
    );
  }
}

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

async function email() {
  return DI.resolve(EmailService);
}

async function q() {
  return DI.resolve(QueueService);
}

describe('smtp email transport', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);

    const b = await DI.resolve(QueueBootstrapper);
    await b.bootstrap();

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    const queue = await q();

    await queue.dispose();
  });

  it('Should send deferred', async () => {
    const e = await email();

    await e.sendDeferred({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - text email',
      connection: 'test',
    });
  });

  it('Should connect to test email server', async () => {
    await email();
  });

  it('Should send text email', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - text email',
      connection: 'test',
    });
  });

  it('Should send email with pug template', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - pug template',
      connection: 'test',
      model: {
        hello: 'world',
      },
      template: 'test.pug',
    });
  });

  it('Should send email with handlebar template', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - handlebar template',
      connection: 'test',
      model: {
        hello: 'world',
      },
      template: 'test.handlebars',
    });
  });

  it('Should send email with attachements', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - with attachements',
      connection: 'test',
      text: 'test attachement',
      attachements: [
        {
          name: 'test.txt',
          path: './test.txt',
        },
      ],
    });
  });

  it('should sent email template with lang', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - language support',
      connection: 'test',
      model: {
        hello: 'world',
      },
      template: 'test-lang.pug',
      lang: 'en',
    });
  });

  it('Should send to multiple receipents', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com', 'test2@spinaje.com'],
      from: 'test@spinajs.com',
      subject: 'test email - multiple receipents',
      connection: 'test',
      text: 'test attachement',
    });
  });

  it('Should send from second connection', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - text email',
      connection: 'test2',
    });
  });

  it('Should emit event when email is sent', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - text email',
      connection: 'test2',
    });
  });
});
