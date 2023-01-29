import { AsyncLocalStorage } from 'async_hooks';
import { Templates } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);


export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
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
          templates: [dir('./templates'), dir('templates_2')],
        },
      },
    };
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

  it('should render pug', async () => {
    const t = await tp();
    const result = await t.render(dir('templates/template.pug'), { hello: 'world' });

    expect(result).to.eq('<p>hello world</p>');
  });

  it('should render pug with lang', async () => {
    const t = await tp();
    const result = await t.render(dir('templates/template.pug'), { hello: 'world' }, 'en');

    expect(result).to.eq('<p>hello world en_US</p>');
  });

  it('should render pug with lang detected', async () => {
    const store = DI.resolve(AsyncLocalStorage);
    const result = await store.run(
      {
        language: 'en',
      },
      async () => {
        const t = await tp();
        return await t.render(dir('templates/template.pug'), { hello: 'world' });
      },
    );

    expect(result).to.eq('<p>hello world en_US</p>');
  });

  it('should fail when template not exists', async () => {
    const t = await tp();
    expect(t.render(dir('templates/handlebars/template_not_exists.handlebars'), { hello: 'world' })).to.be.rejected;
  });
});
