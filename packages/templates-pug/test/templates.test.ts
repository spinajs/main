import { AsyncLocalStorage } from 'async_hooks';
import { Templates } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { FsBootsrapper, fsService } from '@spinajs/fs';
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

  it('should render pug from fs:// uri', async () => {
    const t = await tp();
    const result = await t.render('fs://test-templates/uri-template.pug', { hello: 'world' });

    expect(result).to.include('world');
  });

  it('should not mutate the caller model', async () => {
    const t = await tp();
    const m: Record<string, unknown> = { a: 1 };

    await t.render(dir('templates/template.pug'), m, 'en');

    expect(Object.keys(m)).to.eql(['a']);
    expect(m.a).to.eq(1);
  });

  it('should render to file', async () => {
    const t = await tp();
    const outDir = mkdtempSync(join(tmpdir(), 'pug-render-'));
    const outFile = join(outDir, 'nested', 'out.html');

    try {
      await t.renderToFile(dir('templates/template.pug'), { hello: 'world' }, outFile, 'en');

      expect(existsSync(outFile)).to.eq(true);
      expect(readFileSync(outFile, 'utf-8')).to.eq('<p>hello world en_US</p>');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
