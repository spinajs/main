import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import '../src';
import { Emails } from '@spinajs/email';
import servers from './config';

chai.use(chaiAsPromised);
//const expect = chai.expect;

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        system: {
          dirs: {
            templates: [dir('./templates')],
          },
        },
        email: {
          connections: servers,
        },
        fs: {
          providers: [
            {
              service: 'fsNative',
              name: 'fs-local',
              basePath: dir('./files'),
            },
          ],
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
  return DI.resolve(Emails);
}

describe('smtp email transport', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
  });

  beforeEach(async () => {
    DI.clearCache();
    await DI.resolve(Configuration);
  });

  it('Should send text email', async () => {
    const e = await email();

    await e.send({
      to: ['test@spinajs.com'],
      from: 'test@spinajs.com',
      subject: 'test email',
      connection: 'test',
    });
  });

  it('Should send email with pug template', async () => {});

  it('Should send email with handlebar template', async () => {});

  it('Should send email with attachements', async () => {});

  it('Should send to multiple receipents', async () => {});
});
