import { Templates, TemplateRenderer } from '../src/index.js';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { join, normalize, resolve } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * The templates package ships no renderer of its own (renderers depend on it,
 * not the reverse), so tests exercise the base class through a stub that
 * records how many times it actually compiled.
 */
@Injectable(TemplateRenderer)
export class StubRenderer extends TemplateRenderer {
  public static CompileCount = 0;

  public get Type() {
    return 'stub';
  }

  public get Extension() {
    return '.test-tpl';
  }

  public async render(template: string, _model: unknown, _language?: string): Promise<string> {
    const compiled = await this.withCache(template, async () => {
      StubRenderer.CompileCount++;
      return await this.resolveContent(template);
    });

    return compiled;
  }

  public async renderToFile(): Promise<void> {
    // not exercised by these tests
  }

  /**
   * Per-test reset. The DI container is bootstrapped once for the whole suite
   * (see below), so state that would otherwise die with the container has to be
   * cleared by hand between tests.
   */
  public reset() {
    this.Cache.clear();
    StubRenderer.CompileCount = 0;
  }
}

class ConfigurationForTests extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      templates: {},
      fs: {
        defaultProvider: 'test',
        providers: [{ service: 'fsNative', name: 'test', basePath: dir('./files') }],
      },
    };
  }
}

let Cfg: Configuration;
let TemplatesInstance: Templates;
let Renderer: StubRenderer;

/**
 * Bootstrapped exactly once. `@Config` memoizes the Configuration *instance* in a
 * decorator closure that outlives DI.clearCache(), so re-registering a fresh
 * Configuration per test would leave the decorators reading the first instance
 * forever and every cache mode would silently read as the default. One container
 * for the suite keeps the decorators and the config we mutate in agreement.
 */
before(async () => {
  DI.resolve(FsBootsrapper).bootstrap();
  DI.register(ConfigurationForTests).as(Configuration);
  Cfg = await DI.resolve(Configuration);
  await DI.resolve(fsService);

  TemplatesInstance = await DI.resolve(Templates);
  Renderer = TemplatesInstance.getRendererFor('.test-tpl') as StubRenderer;
});

async function setup(cacheMode?: string) {
  Cfg.set('templates.cache.mode', cacheMode);
  Renderer.reset();

  return TemplatesInstance;
}

async function writeTemplate(content: string) {
  await mkdir(dir('./files'), { recursive: true });
  await writeFile(dir('./files/stub.test-tpl'), content, 'utf-8');
}

describe('templates fs resolution', () => {
  beforeEach(async () => {
    await writeTemplate('hello');
  });

  it('should render from a bare local path (regression)', async () => {
    const t = await setup();
    const result = await t.render(dir('./files/stub.test-tpl'), {});

    expect(result).to.eq('hello');
  });

  it('should render from an fs:// uri', async () => {
    const t = await setup();
    const result = await t.render('fs://test/stub.test-tpl', {});

    expect(result).to.eq('hello');
  });

  it('should fail with InvalidArgument for an unregistered filesystem', async () => {
    const t = await setup();

    await expect(t.render('fs://not-registered/stub.test-tpl', {})).to.be.rejected;
  });
});

describe('templates cache modes', () => {
  beforeEach(async () => {
    await writeTemplate('hello');
  });

  it('cache mode should compile once and ignore source changes', async () => {
    const t = await setup('cache');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    await writeTemplate('changed');
    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    expect(StubRenderer.CompileCount).to.eq(1);
  });

  it('cache should be the default mode', async () => {
    const t = await setup();

    await t.render('fs://test/stub.test-tpl', {});
    await writeTemplate('changed');
    await t.render('fs://test/stub.test-tpl', {});

    expect(StubRenderer.CompileCount).to.eq(1);
  });

  it('revalidate mode should recompile only after the source changes', async () => {
    const t = await setup('revalidate');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    expect(StubRenderer.CompileCount).to.eq(1);

    // mtime has 1s granularity on some filesystems; size differs here so the
    // token changes regardless
    await writeTemplate('changed content');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('changed content');
    expect(StubRenderer.CompileCount).to.eq(2);
  });

  it('always mode should recompile on every render', async () => {
    const t = await setup('always');

    await t.render('fs://test/stub.test-tpl', {});
    await t.render('fs://test/stub.test-tpl', {});

    expect(StubRenderer.CompileCount).to.eq(2);
  });

  it('revalidate should serve the cached entry when stat fails', async () => {
    const t = await setup('revalidate');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');

    // provider stat now throws; the cached entry must still be served
    const provider: any = await DI.resolve('__file_provider__', ['test']);
    const original = provider.stat.bind(provider);
    provider.stat = () => Promise.reject(new Error('transient failure'));

    try {
      expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
      expect(StubRenderer.CompileCount).to.eq(1);
    } finally {
      // must run even if an assertion throws, otherwise the patched stat leaks
      // into every test that runs after this one
      provider.stat = original;
    }
  });
});
