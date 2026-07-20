import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { IRenderProgress, RenderPhase } from '@spinajs/templates';
import { PdfRenderer } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

const IMAGE_COUNT = 100;

// Opt-in: the picsum.photos variant needs internet and is slow, so it is skipped
// unless RUN_NETWORK_TESTS is set. The local variant always runs.
const runOnline = !!process.env.RUN_NETWORK_TESTS;

class ConnectionConf extends FrameworkConfiguration {
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
      templates: {
        pdf: {
          static: { portRange: [8080, 8090] },
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          // generous timeouts: 100 images (esp. remote) take a while
          renderDurationWarning: 60000,
          navigationTimeout: 60000,
          renderTimeout: 60000,
        },
      },
    };
  }
}

/**
 * HTML whose inline script synchronously injects `IMAGE_COUNT` <img> elements.
 * Because the injection is synchronous, the page's `load` event (which
 * page.setContent awaits) waits for every image to settle - so the progress
 * reporter's request/response counters capture them all.
 */
function imagesHtml(srcExpr: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  for (let i = 0; i < ${IMAGE_COUNT}; i++) {
    const img = document.createElement('img');
    img.width = 40; img.height = 40;
    img.src = ${srcExpr};
    document.body.appendChild(img);
  }
</script>
</body></html>`;
}

async function pdf(): Promise<PdfRenderer> {
  return DI.resolve(PdfRenderer, [{ format: 'A4', printBackground: true }]);
}

function assertProgress(events: IRenderProgress[], minLoaded: number) {
  expect(events.length, 'progress reported').to.be.greaterThan(0);
  expect(events.some((e) => e.phase === RenderPhase.Loading), 'a loading phase was reported').to.eq(true);

  // percent never regresses and ends complete
  for (let i = 1; i < events.length; i++) {
    expect(events[i].percent, 'percent must not regress').to.be.gte(events[i - 1].percent);
  }
  const last = events[events.length - 1];
  expect(last.phase).to.eq(RenderPhase.Done);
  expect(last.percent).to.eq(100);
  expect(last.resourcesLoaded, `at least ${minLoaded} images tracked`).to.be.gte(minLoaded);
}

describe('PDF render progress with many images', function () {
  this.timeout(90000);

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

  it(`reports progress while a script loads ${IMAGE_COUNT} images from the local server`, async () => {
    const r = await pdf();
    const out = dir('fixtures/progress-local.pdf');
    outputs.push(out);

    const events: IRenderProgress[] = [];
    // relative src -> resolved against the injected <base href> of the local asset
    // server; the `?i=` cache-buster makes each of the 100 a distinct request
    const html = imagesHtml("'img.png?i=' + i");

    await r.renderHtmlToFile(html, out, {
      assetBasePath: dir('assets'),
      onProgress: (p) => {
        events.push({ ...p });
      },
    });

    expect(fs.existsSync(out)).to.eq(true);
    expect(fs.statSync(out).size).to.be.greaterThan(0);
    // deterministic: all 100 are served locally
    assertProgress(events, IMAGE_COUNT);
  });

  (runOnline ? it : it.skip)(`reports progress while a script loads ${IMAGE_COUNT} images from picsum.photos`, async () => {
    const r = await pdf();
    const out = dir('fixtures/progress-online.pdf');
    outputs.push(out);

    const events: IRenderProgress[] = [];
    const html = imagesHtml("'https://picsum.photos/seed/' + i + '/40/40'");

    await r.renderHtmlToFile(html, out, {
      onProgress: (p) => {
        events.push({ ...p });
      },
    });

    expect(fs.existsSync(out)).to.eq(true);
    expect(fs.statSync(out).size).to.be.greaterThan(0);
    // lenient: a few remote images may 429 / time out under concurrent load
    assertProgress(events, Math.floor(IMAGE_COUNT * 0.8));
  });
});
