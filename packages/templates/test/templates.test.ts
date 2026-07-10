import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Templates, TemplateRenderer, IRenderOptions, IRenderProgress, RenderPhase, cliProgressReporter, formatProgressLine } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * Fake renderers used to exercise the Templates facade in isolation - the
 * renderer selection (by type / by extension) and its error paths - without
 * pulling in a real template engine or touching the filesystem.
 */
@Injectable(TemplateRenderer)
class FooRenderer extends TemplateRenderer {
  public renderCalls: Array<{ template: string; model: unknown; language?: string; options?: IRenderOptions }> = [];
  public renderToFileCalls: Array<{ template: string; filePath: string; options?: IRenderOptions }> = [];

  public get Type() {
    return 'foo';
  }

  public get Extension() {
    return '.foo';
  }

  public render(templatePath: string, model: unknown, language?: string, options?: IRenderOptions): Promise<string> {
    this.renderCalls.push({ template: templatePath, model, language, options });
    return Promise.resolve(`foo:${templatePath}:${language ?? ''}`);
  }

  public renderToFile(templatePath: string, _model: unknown, filePath: string, _language?: string, options?: IRenderOptions): Promise<void> {
    this.renderToFileCalls.push({ template: templatePath, filePath, options });
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
      expect(foo.renderToFileCalls.some((c) => c.template === 'some/template' && c.filePath === 'out.foo')).to.eq(true);
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
      expect(foo.renderToFileCalls.some((c) => c.template === 'report.foo' && c.filePath === 'out.txt')).to.eq(true);
    });

    it('throws InvalidOperation when no renderer matches the extension', async () => {
      const t = await tp();
      await expect(t.renderToFile('report.unknown', {}, 'out.txt')).to.be.rejectedWith(InvalidOperation);
    });
  });

  describe('render options forwarding', () => {
    it('forwards options (onProgress) to the engine on render', async () => {
      const t = await tp();
      const onProgress = () => undefined;
      await t.render('report.foo', {}, 'en', { onProgress });
      const foo = t.getRendererFor('.foo') as FooRenderer;
      expect(foo.renderCalls[foo.renderCalls.length - 1]?.options?.onProgress).to.eq(onProgress);
    });

    it('forwards options (onProgress) to the engine on renderToFile', async () => {
      const t = await tp();
      const onProgress = () => undefined;
      await t.renderToFile('report.foo', {}, 'out.txt', 'en', { onProgress });
      const foo = t.getRendererFor('.foo') as FooRenderer;
      expect(foo.renderToFileCalls[foo.renderToFileCalls.length - 1]?.options?.onProgress).to.eq(onProgress);
    });

    it('forwards options through compile/compileToFile (by renderer type)', async () => {
      const t = await tp();
      const onProgress = () => undefined;
      await t.compile('some/template', 'foo', {}, 'en', { onProgress });
      await t.compileToFile('some/template', 'foo', {}, 'out.foo', 'en', { onProgress });
      const foo = t.getRendererFor('.foo') as FooRenderer;
      expect(foo.renderCalls[foo.renderCalls.length - 1]?.options?.onProgress).to.eq(onProgress);
      expect(foo.renderToFileCalls[foo.renderToFileCalls.length - 1]?.options?.onProgress).to.eq(onProgress);
    });
  });
});

describe('cliProgressReporter / formatProgressLine', () => {
  const snapshot = (phase: RenderPhase, percent: number): IRenderProgress => ({
    phase,
    percent,
    resourcesLoaded: 0,
    resourcesPending: 0,
    resourcesFailed: 0,
    elapsedMs: 0,
    filePath: 'out.pdf',
  });

  it('formats a snapshot into a single line with percent and phase', () => {
    const line = formatProgressLine(snapshot(RenderPhase.Loading, 42));
    expect(line).to.contain('42%');
    expect(line).to.contain('loading');
  });

  it('non-TTY: prints one line per phase change, not per event', () => {
    const lines: string[] = [];
    const report = cliProgressReporter((s) => lines.push(s), false);

    report(snapshot(RenderPhase.Starting, 0));
    report(snapshot(RenderPhase.Starting, 0)); // same phase -> no extra line
    report(snapshot(RenderPhase.Loading, 40));
    report(snapshot(RenderPhase.Loading, 60)); // same phase -> no extra line
    report(snapshot(RenderPhase.Done, 100));

    expect(lines.length).to.eq(3);
    expect(lines[0]).to.contain('starting');
    expect(lines[2]).to.contain('done');
  });

  it('TTY: rewrites a single live line and closes it on Done', () => {
    const writes: string[] = [];
    const report = cliProgressReporter((s) => writes.push(s), true);

    report(snapshot(RenderPhase.Loading, 40));
    report(snapshot(RenderPhase.Done, 100));

    // every live update starts with a carriage return
    expect(writes[0].startsWith('\r')).to.eq(true);
    // the final newline terminates the live line
    expect(writes[writes.length - 1]).to.eq('\n');
  });
});
