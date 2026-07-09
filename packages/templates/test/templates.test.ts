import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Templates, TemplateRenderer } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * Fake renderers used to exercise the Templates facade in isolation - the
 * renderer selection (by type / by extension) and its error paths - without
 * pulling in a real template engine or touching the filesystem.
 */
@Injectable(TemplateRenderer)
class FooRenderer extends TemplateRenderer {
  public renderCalls: Array<{ template: string; model: unknown; language?: string }> = [];
  public renderToFileCalls: Array<{ template: string; filePath: string }> = [];

  public get Type() {
    return 'foo';
  }

  public get Extension() {
    return '.foo';
  }

  public render(templatePath: string, model: unknown, language?: string): Promise<string> {
    this.renderCalls.push({ template: templatePath, model, language });
    return Promise.resolve(`foo:${templatePath}:${language ?? ''}`);
  }

  public renderToFile(templatePath: string, _model: unknown, filePath: string): Promise<void> {
    this.renderToFileCalls.push({ template: templatePath, filePath });
    return Promise.resolve();
  }

  protected compile(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable(TemplateRenderer)
class BarRenderer extends TemplateRenderer {
  public get Type() {
    return 'bar';
  }

  public get Extension() {
    return '.bar';
  }

  public render(templatePath: string): Promise<string> {
    return Promise.resolve(`bar:${templatePath}`);
  }

  public renderToFile(): Promise<void> {
    return Promise.resolve();
  }

  protected compile(): Promise<void> {
    return Promise.resolve();
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      intl: {
        defaultLocale: 'pl',
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
          locales: [],
          templates: [],
        },
      },
    };
  }
}

async function tp() {
  return DI.resolve(Templates);
}

describe('Templates facade', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  describe('getRendererFor', () => {
    it('returns the renderer matching the extension', async () => {
      const t = await tp();
      expect(t.getRendererFor('.foo')).to.be.instanceOf(FooRenderer);
      expect(t.getRendererFor('.bar')).to.be.instanceOf(BarRenderer);
    });
  });

  describe('compile (render by renderer type)', () => {
    it('routes to the renderer selected by type', async () => {
      const t = await tp();
      const result = await t.compile('some/template', 'foo', { a: 1 }, 'en');
      expect(result).to.eq('foo:some/template:en');
    });

    it('throws InvalidOperation for an unknown renderer type', async () => {
      const t = await tp();
      await expect(t.compile('some/template', 'does-not-exist', {})).to.be.rejectedWith(InvalidOperation);
    });
  });

  describe('compileToFile (render to file by renderer type)', () => {
    it('routes to the renderer selected by type', async () => {
      const t = await tp();
      await t.compileToFile('some/template', 'foo', {}, 'out.foo');
      const foo = t.getRendererFor('.foo') as FooRenderer;
      expect(foo.renderToFileCalls).to.deep.include({ template: 'some/template', filePath: 'out.foo' });
    });

    it('throws InvalidOperation for an unknown renderer type', async () => {
      const t = await tp();
      await expect(t.compileToFile('some/template', 'nope', {}, 'out.x')).to.be.rejectedWith(InvalidOperation);
    });
  });

  describe('render (detect renderer by file extension)', () => {
    it('selects the renderer by the template file extension', async () => {
      const t = await tp();
      expect(await t.render('report.foo', {})).to.eq('foo:report.foo:');
      expect(await t.render('report.bar', {})).to.eq('bar:report.bar');
    });

    it('forwards the language to the renderer', async () => {
      const t = await tp();
      expect(await t.render('report.foo', {}, 'en')).to.eq('foo:report.foo:en');
    });

    it('throws InvalidOperation when no renderer matches the extension', async () => {
      const t = await tp();
      await expect(t.render('report.unknown', {})).to.be.rejectedWith(InvalidOperation);
    });
  });

  describe('renderToFile (detect renderer by file extension)', () => {
    it('selects the renderer by the template file extension', async () => {
      const t = await tp();
      await t.renderToFile('report.foo', {}, 'out.txt');
      const foo = t.getRendererFor('.foo') as FooRenderer;
      expect(foo.renderToFileCalls).to.deep.include({ template: 'report.foo', filePath: 'out.txt' });
    });

    it('throws InvalidOperation when no renderer matches the extension', async () => {
      const t = await tp();
      await expect(t.renderToFile('report.unknown', {}, 'out.txt')).to.be.rejectedWith(InvalidOperation);
    });
  });
});
