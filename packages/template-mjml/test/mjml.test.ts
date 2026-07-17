import { Templates } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import "@spinajs/templates-handlebars";
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
          templates: [dir('./templates')],
        },
      },
      fs: {
        defaultProvider: 'test-templates',
        providers: [{ service: 'fsNative', name: 'test-templates', basePath: dir('./templates') }],
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
    DI.resolve(FsBootsrapper).bootstrap();
    DI.register(ConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
  });
 
  it('should render mjml', async () => {
    const t = await tp();
    const result = await t.render(dir('templates/simple.mjml'), { hello: 'world' });
    expect(result).to.eq('hello world');
  });

  it('should render mjml from fs:// uri', async () => {
    const t = await tp();
    const result = await t.render('fs://test-templates/uri-template.mjml', { hello: 'world' });

    expect(result).to.include('world');
    expect(result).to.include('<!doctype html>');
  });
});
