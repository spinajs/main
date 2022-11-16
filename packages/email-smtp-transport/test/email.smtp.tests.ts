import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import '../src';
import servers from './config';
import { EmailSenderSmtp } from '../src';
import { expect } from 'chai';
import '@spinajs/templates-handlebars';
import '@spinajs/templates-pug';

chai.use(chaiAsPromised);

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
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
              type: 'BlackHoleTarget',
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
  return DI.resolve(EmailSenderSmtp, servers);
}

async function email2() {
  return DI.resolve(EmailSenderSmtp, [
    {
      name: 'test',
      service: 'EmailSenderSmtp',
      host: 'smtp.mailtrap.io',
      port: 2525,
      user: 'ddd',
      pass: '222',
    },
  ]);
}

describe('smtp email transport', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
  });

  beforeEach(async () => {
    DI.clearCache();
    await DI.resolve(Configuration);
  });

  it('Should connect to test email server', async () => {
    await email();
  });

  it('Should throw when cannot connect', async () => {
    expect(email2()).to.be.rejected;
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
});
