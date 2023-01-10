import { Templates } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import * as fs from 'fs';
import './../src';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
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
              layout: '{datetime} {level} {message} {error} duration: {duration} ({logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        system: {
          dirs: {
            locales: [dir('./lang')],
            templates: [dir('./templates')],
          },
        },
      },
      mergeArrays,
    );
  }
}

async function tp() {
  return await DI.resolve(Templates);
}

describe('templates', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  it('should render xlsx to file', async () => {
    const t = await tp();
    await t.renderToFile('template.xlsx', { hello: 'world' }, dir('./templates/rendered_template.xlsx'));

    const exists = fs.existsSync(dir('./templates/rendered_template.xlsx'));
    expect(exists).to.eq(true);
  });

  it('should fail when template not exists', async () => {
    const t = await tp();
    expect(t.render('template_not_exists.xlsx', { hello: 'world' })).to.be.rejected;
  });
});
