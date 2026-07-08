import { Templates, TemplateRenderer } from '@spinajs/templates';
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

  it('should reject when the template does not exist', async () => {
    const r = await renderer();
    await expect(
      r.renderToFile(dir('templates/does-not-exist.png'), { hello: 'world' }, dir('templates/nope.png')),
    ).to.be.rejected;
  });
});
