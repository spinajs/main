import { Templates } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * pdf.js draws glyph outlines and images through the global `Path2D` / `DOMMatrix` /
 * `ImageData` constructors, which do not exist in Node. When they are missing pdf.js
 * polyfills them from *its own* (possibly nested, non-deduped) copy of @napi-rs/canvas,
 * and skia rejects path/image objects that come from a different native instance
 * ("Value is none of these types `String`, `Path`"). Priming the globals from the copy we
 * import here - before pdf.js is ever loaded - keeps everything on one instance regardless
 * of how npm happens to hoist the package.
 */
const g = globalThis as any;
g.Path2D ??= Path2D;
g.DOMMatrix ??= DOMMatrix;
g.ImageData ??= ImageData;

// NOTE: must stay a dynamic import so it is evaluated *after* the globals above are set.
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Scale at which page 1 of the produced PDF is rasterized. Must stay in sync with the
 * committed golden image - changing it invalidates the golden.
 */
const RASTER_SCALE = 2;

/**
 * pixelmatch per-pixel colour distance tolerance (0 - 1, smaller is stricter).
 */
const PIXEL_THRESHOLD = 0.1;

/**
 * Maximum fraction of differing pixels that is still considered "no regression".
 */
const MAX_MISMATCH_RATIO = 0.005;

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
        pdf: {
          static: {
            portRange: [8080, 8090],
          },
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          options: {},
          renderDurationWarning: 5000,
          renderTimeout: 30000,
        },
      },
    };
  }
}

/**
 * Minimal canvas factory for pdf.js backed by @napi-rs/canvas (prebuilt skia binding, so no
 * node-gyp / node-canvas build is required). pdf.js uses it for any auxiliary canvases it
 * needs while rendering (masks, patterns, gradients).
 */
class NapiCanvasFactory {
  public create(width: number, height: number) {
    const canvas = createCanvas(Math.max(1, width | 0), Math.max(1, height | 0));
    return { canvas, context: canvas.getContext('2d') };
  }

  public reset(canvasAndContext: { canvas: any }, width: number, height: number) {
    canvasAndContext.canvas.width = Math.max(1, width | 0);
    canvasAndContext.canvas.height = Math.max(1, height | 0);
  }

  public destroy(canvasAndContext: { canvas: any; context: any }) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

/**
 * Rasterizes page 1 of the given PDF file to a PNG buffer at a fixed scale.
 */
async function rasterizeFirstPage(pdfPath: string, scale: number): Promise<Buffer> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data,
    // deterministic text rendering - never fall back to whatever fonts the host happens to have
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    // force every auxiliary canvas pdf.js creates onto the same @napi-rs/canvas instance
    // this test draws on - its own NodeCanvasFactory may resolve a different copy
    CanvasFactory: NapiCanvasFactory,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');

    // pdf.js renders with alpha - paint an opaque white background first so the
    // rasterization is stable regardless of how the PDF declares its page background
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context as any,
      viewport,
    }).promise;

    return canvas.toBuffer('image/png');
  } finally {
    await doc.destroy();
  }
}

describe('visual regression', function () {
  this.timeout(60000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await DI.dispose();
  });

  it('renders visual.pug to a PDF that matches the golden image', async () => {
    const templates = await DI.resolve(Templates);

    const outDir = dir('output');
    const goldenDir = dir('visual');
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(goldenDir, { recursive: true });

    const pdfPath = join(outDir, 'visual.pdf');
    const goldenPath = join(goldenDir, 'golden.png');
    const actualPath = join(goldenDir, 'actual.png');
    const diffPath = join(goldenDir, 'diff.png');

    try {
      await templates.renderToFile(dir('templates/visual.pdf'), {}, pdfPath);
      expect(fs.existsSync(pdfPath), 'renderer did not produce a PDF').to.eq(true);

      const actualPng = await rasterizeFirstPage(pdfPath, RASTER_SCALE);

      // first run / explicit refresh - (re)create the golden and pass
      if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(goldenPath)) {
        const created = !fs.existsSync(goldenPath);
        fs.writeFileSync(goldenPath, actualPng);
        // eslint-disable-next-line no-console
        console.warn(`[visual] ${created ? 'golden image was missing and has been created' : 'golden image updated (UPDATE_GOLDEN=1)'} at ${goldenPath}. Review it and commit it.`);
        return;
      }

      const golden = PNG.sync.read(fs.readFileSync(goldenPath));
      const actual = PNG.sync.read(actualPng);

      expect(`${actual.width}x${actual.height}`, 'rasterized page size differs from the golden image - re-run with UPDATE_GOLDEN=1 if this is intentional').to.eq(`${golden.width}x${golden.height}`);

      const diff = new PNG({ width: golden.width, height: golden.height });
      const mismatched = pixelmatch(golden.data, actual.data, diff.data, golden.width, golden.height, { threshold: PIXEL_THRESHOLD });

      const total = golden.width * golden.height;
      const ratio = mismatched / total;

      if (ratio >= MAX_MISMATCH_RATIO) {
        fs.writeFileSync(actualPath, actualPng);
        fs.writeFileSync(diffPath, PNG.sync.write(diff));
      }

      expect(ratio, `visual regression: ${mismatched}/${total} pixels differ (${(ratio * 100).toFixed(3)}%, allowed < ${(MAX_MISMATCH_RATIO * 100).toFixed(3)}%). See ${actualPath} and ${diffPath}`).to.be.lessThan(MAX_MISMATCH_RATIO);

      // passing run - leave no stray artifacts behind
      for (const f of [actualPath, diffPath]) {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      }
    } finally {
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
    }
  });
});
