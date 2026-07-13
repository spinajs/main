import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Templates } from '@spinajs/templates';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { fs, fsService, FsBootsrapper } from '@spinajs/fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import { IRenderRequest, IRenderOutput, WorkerMessage } from './protocol.js';

// registers the PDF renderer (+ puppeteer/pug) and the fs providers as a side effect
import '@spinajs/templates-pdf';
import '@spinajs/fs';

type ProgressMessage = Extract<WorkerMessage, { type: 'progress' }>;

let tmpCounter = 0;

/**
 * Bootstrap the worker's DI/config. With an inline `config` a Configuration is
 * registered from it; otherwise the ambient Configuration is resolved (the
 * re-bootstrap model - the worker shares the app's config environment). The fs
 * providers are then initialized.
 */
async function bootstrap(config?: unknown): Promise<void> {
  if (config) {
    class WorkerConfiguration extends FrameworkConfiguration {
      protected onLoad() {
        return config;
      }
    }
    DI.register(WorkerConfiguration).as(Configuration);
  }

  await DI.resolve(Configuration);

  // register the `__file_provider__` factory, then build the configured providers
  const fsBootstrapper = await DI.resolve(FsBootsrapper);
  fsBootstrapper.bootstrap();
  await DI.resolve(fsService);
}

/**
 * Render a PDF for `req` and upload it to the requested @spinajs/fs provider,
 * reporting progress via `onProgress`. This is the testable core shared by the
 * worker entrypoint - it performs the heavy work (template compile, Chromium
 * render, upload) and cleans up its temp file.
 *
 * @returns the output descriptor (provider + path) on success.
 */
export async function renderPdfToProvider(req: IRenderRequest, onProgress: (m: ProgressMessage) => void): Promise<IRenderOutput> {
  await bootstrap(req.config);

  const templates = await DI.resolve(Templates);
  const renderer = await DI.resolve(PdfRenderer, [req.pdfOptions ?? {}]);
  const provider = await DI.resolve<fs>('__file_provider__', [req.output.provider]);

  const html = req.template ? await templates.render(req.input, req.model, req.lang) : req.input;

  const tmp = join(tmpdir(), `spinajs-pdf-${process.pid}-${Date.now()}-${tmpCounter++}.pdf`);

  try {
    await renderer.renderHtmlToFile(html, tmp, {
      assetBasePath: req.assetBasePath,
      onProgress: (p) => onProgress({ type: 'progress', percent: p.percent, phase: p.phase, message: p.message }),
    });

    // push the locally-rendered temp file to the configured destination provider
    await provider.upload(tmp, req.output.path);

    return req.output;
  } finally {
    await unlink(tmp).catch(() => {
      /* temp may not exist if the render failed before writing */
    });
  }
}
