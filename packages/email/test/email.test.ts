import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { DateTime } from 'luxon';

import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { JobModel, QueueService } from '@spinajs/queue';
import { DI } from '@spinajs/di';
import '@spinajs/templates-handlebars';
import '@spinajs/templates-pug';
import '../../queue-stomp-transport/lib/mjs/connection.js';
import '@spinajs/email-smtp-transport';
import '@spinajs/orm-sqlite';

import { EmailService } from '../src/index.js';
import { fs, FsBootsrapper } from '@spinajs/fs';

chai.use(chaiAsPromised);

const TestEventChannelName = `/topic/test-${DateTime.now().toMillis()}`;
const TestJobChannelName = `/queue/test-${DateTime.now().toMillis()}`;

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      system: {
        dirs: {
          locales: [dir('./locales')],
        },
      },
      email: {
        connections: [
          {
            name: 'test',
            service: 'EmailSenderSmtp',
            host: 'smtp.mailtrap.io',
            port: 2525,
            user: process.env.SPINE_TEST_EMAIL_USER || '9dd1310b3e28cf',
            pass: process.env.SPINE_TEST_EMAIL_PASSWORD || '2535b401d2ae2b',
          },
          {
            name: 'test2',
            service: 'EmailSenderSmtp',
            host: 'smtp.mailtrap.io',
            port: 2525,
            user: process.env.SPINE_TEST_EMAIL_USER || '9dd1310b3e28cf',
            pass: process.env.SPINE_TEST_EMAIL_PASSWORD || '2535b401d2ae2b',
          },
        ],
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
          {
            service: 'fsNative',
            name: 'fs-template',
            basePath: dir('./templates'),
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
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} (${logger})',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

async function email() {
  return DI.resolve(EmailService);
}

async function q() {
  return DI.resolve(QueueService);
}

async function wait(amount?: number) {
  return new Promise<void>((res) => {
    setTimeout(() => {
      res();
    }, amount ?? 1000);
  });
}

describe('smtp email transport', function () {
  this.timeout(15000);
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);

    const b = await DI.resolve(FsBootsrapper);
    await b.bootstrap();

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    const queue = await q();

    await queue.dispose();
  });

  after(async () => {
    const queue = await q();
    await queue.dispose();
  });

  it('Should send deferred', async () => {
    const e = await email();

    const event = await e.sendDeferred({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test deferred email',
      connection: 'test',
    });

    // email-smtp-transport uses email package
    // so EmailSend is imported from lib
    //const sExecute = sinon.spy(EmailSend.prototype, 'execute');

    let m = await JobModel.where('JobId', event.JobId).first();
    chai.expect(m).to.be.not.null;
    chai.expect(m.Name).to.eq('EmailSend');
    chai.expect(m.FinishedAt).to.eq(null);
    chai.expect(m.Progress).to.eq(0);

    await e.processDefferedEmails();
    await wait(10000);

    //chai.expect(sExecute.calledOnce).to.be.true;
    m = await JobModel.where('JobId', event.JobId).first();
    chai.expect(m.FinishedAt).to.be.not.null;
    chai.expect(m.Progress).to.eq(100);
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
    const fs = await DI.resolve<fs>('__file_provider__', ['fs-template']);
    const file = await fs.download('test.pug');
    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - pug template',
      connection: 'test',
      model: {
        hello: 'world',
      },
      template: file,
    });
  });

  it('Should send email with handlebar template', async () => {
    const e = await email();
    const fs = await DI.resolve<fs>('__file_provider__', ['fs-template']);
    const file = await fs.download('test.handlebars');
    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - handlebar template',
      connection: 'test',
      model: {
        hello: 'world',
      },
      template: file,
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
    const f = await DI.resolve<fs>('__file_provider__', ['fs-templates']);
    const file = await f.download('test-lang.pug');
    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email - language support',
      connection: 'test',
      model: {
        hello: 'world',
      },
      template: file,
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
