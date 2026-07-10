import { Templates, TemplateRenderer, IRenderProgress, RenderPhase } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration, Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { Page } from 'puppeteer';
import { join, normalize, resolve } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { PuppeteerRenderer, IPuppeteerRendererOptions } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Minimal concrete renderer used only to exercise the abstract PuppeteerRenderer
 * engine (local server, pooled browser, page lifecycle). It just screenshots the page.
 */
@Injectable(TemplateRenderer)
class TestPuppeteerRenderer extends PuppeteerRenderer {
  @Config('templates.puppeteerTest')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'puppeteer-test';
  }

  public get Extension() {
    return '.png';
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.screenshot({ path: filePath });
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '{datetime} {level} {message} {error} duration: {duration} ({logger})',
          },
        ],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      system: {
        dirs: {
          locales: [dir('./lang')],
          templates: [dir('./templates')],
        },
      },
      templates: {
        puppeteerTest: {
          static: {
            portRange: [8080, 8090],
          },
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          renderDurationWarning: 5000,
          renderTimeout: 30000,
        },
      },
    };
  }
}

async function renderer(): Promise<TestPuppeteerRenderer> {
  const templates = await DI.resolve(Templates);
  return templates.getRendererFor('.png') as TestPuppeteerRenderer;
}

describe('PuppeteerRenderer engine', function () {
  this.timeout(20000);

  const outputs: string[] = [];

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    for (const f of outputs.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    // dispose so the pooled browser is closed and the process can exit
    await DI.dispose();
  });

  it('should render a page to a file', async () => {
    const r = await renderer();
    const out = dir('templates/render-once.png');
    outputs.push(out);

    await r.renderToFile(dir('templates/template.png'), { hello: 'world' }, out);

    expect(fs.existsSync(out)).to.eq(true);
  });

  it('should reuse the pooled browser across renders', async () => {
    const r = await renderer();
    const out1 = dir('templates/pool-1.png');
    const out2 = dir('templates/pool-2.png');
    outputs.push(out1, out2);

    await r.renderToFile(dir('templates/template.png'), { hello: 'world' }, out1);
    const firstBrowser = (r as any).pooledBrowser;
    expect(firstBrowser, 'browser should be pooled after first render').to.not.be.null;

    await r.renderToFile(dir('templates/template.png'), { hello: 'world' }, out2);
    const secondBrowser = (r as any).pooledBrowser;

    expect(secondBrowser).to.equal(firstBrowser); // same instance -> reused, not relaunched
    expect(secondBrowser.connected).to.eq(true);
  });

  it('should close the pooled browser on dispose()', async () => {
    const r = await renderer();
    const out = dir('templates/dispose.png');
    outputs.push(out);

    await r.renderToFile(dir('templates/template.png'), { hello: 'world' }, out);
    const browser = (r as any).pooledBrowser;
    expect(browser).to.not.be.null;

    await r.dispose();

    expect((r as any).pooledBrowser).to.be.null;
    expect(browser.connected).to.eq(false);
  });

  it('should render a raw HTML string to a file', async () => {
    const r = await renderer();
    const out = dir('templates/raw-html.png');
    outputs.push(out);

    await r.renderHtmlToFile('<h1>hello from raw html</h1>', out);

    expect(fs.existsSync(out)).to.eq(true);
    expect(fs.statSync(out).size).to.be.greaterThan(0);
  });

  it('should honor an explicit viewport for raw HTML', async () => {
    const r = await renderer();
    const out = dir('templates/viewport.png');
    outputs.push(out);

    await r.renderHtmlToFile('<h1>viewport</h1>', out, {
      viewport: { width: 400, height: 300, deviceScaleFactor: 1 },
    });

    // PNG stores width/height as big-endian uint32 at byte offsets 16 and 20
    const buf = fs.readFileSync(out);
    expect(buf.readUInt32BE(16)).to.eq(400);
    expect(buf.readUInt32BE(20)).to.eq(300);
  });

  it('should reject when the template does not exist', async () => {
    const r = await renderer();
    await expect(
      r.renderToFile(dir('templates/does-not-exist.png'), { hello: 'world' }, dir('templates/nope.png')),
    ).to.be.rejected;
  });

  it('should report progress through phases with resource counts', async () => {
    const r = await renderer();
    const out = dir('templates/progress.png');
    outputs.push(out);

    const events: IRenderProgress[] = [];
    // three local images -> three real requests to the temporary static server
    const html = '<html><head></head><body><img src="img1.png"><img src="img2.png"><img src="img3.png"></body></html>';

    await r.renderHtmlToFile(html, out, {
      assetBasePath: dir('templates'),
      onProgress: (p) => {
        events.push({ ...p });
      },
    });

    expect(events.length, 'progress should be reported').to.be.greaterThan(0);

    // phases only ever move forward
    const order = [RenderPhase.Starting, RenderPhase.Preparing, RenderPhase.Loading, RenderPhase.Rendering, RenderPhase.Done];
    const indices = events.map((e) => order.indexOf(e.phase)).filter((i) => i >= 0);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i], 'phase must not go backwards').to.be.gte(indices[i - 1]);
    }

    // percent is monotonic non-decreasing and ends at 100
    for (let i = 1; i < events.length; i++) {
      expect(events[i].percent, 'percent must not regress').to.be.gte(events[i - 1].percent);
    }

    const last = events[events.length - 1];
    expect(last.phase).to.eq(RenderPhase.Done);
    expect(last.percent).to.eq(100);

    // the loading phase was observed and the three images were tracked
    expect(events.some((e) => e.phase === RenderPhase.Loading), 'a loading phase was reported').to.eq(true);
    expect(last.resourcesLoaded, 'the three images were counted').to.be.gte(3);
  });

  it('should report a Failed phase when the render fails', async () => {
    const r = await renderer();
    const out = dir('templates/progress-fail.png');
    outputs.push(out);

    const events: IRenderProgress[] = [];
    await expect(
      r.renderToFile(dir('templates/does-not-exist.png'), { hello: 'world' }, out, undefined, {
        onProgress: (p) => {
          events.push({ ...p });
        },
      }),
    ).to.be.rejected;

    expect(events.length).to.be.greaterThan(0);
    expect(events[events.length - 1].phase).to.eq(RenderPhase.Failed);
  });
});
