import { PdfRenderer } from './../index.js';
import { cliProgressReporter, ensureParentDir, resolveInputHtml } from '@spinajs/templates';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { PaperFormat } from 'puppeteer';
import * as path from 'path';
import { Logger, Log } from '@spinajs/log-common';

interface RenderPdfOptions {
  output: string;
  template?: boolean;
  model?: string;
  lang?: string;
  format?: string;
  landscape?: boolean;
  scale?: string;
}

@Command('render-pdf', 'Render an HTML file (or a template) to a PDF - useful in CI for document generation/comparison')
@Argument('input', true, 'path to an .html file, or a template file when --template is set')
@Option('-o, --output <file>', true, 'output PDF file path')
@Option('-t, --template', false, 'treat input as a template rendered via the engine instead of raw HTML')
@Option('-m, --model [model]', false, 'path to a JSON model file (template mode only)')
@Option('-l, --lang [lang]', false, 'optional language (template mode only)')
@Option('--format [format]', false, 'paper format: A4 (default), Letter, Legal, A3, ...')
@Option('--landscape', false, 'render in landscape orientation')
@Option('--scale [scale]', false, 'rendering scale (0.1 - 2, default 1)')
export class RenderPdfCommand extends CliCommand {
  @Logger('templates-pdf')
  protected Log: Log;

  public async execute(input: string, options: RenderPdfOptions): Promise<void> {
    const renderer = await DI.resolve(PdfRenderer, [this.resolvePdfOptions(options)]);

    try {
      this.Log.trace(`Rendering ${input} to pdf ${options.output}, options: ${JSON.stringify(options)}`);

      const html = await resolveInputHtml(input, options);

      ensureParentDir(options.output);

      await renderer.renderHtmlToFile(html, options.output, {
        assetBasePath: path.dirname(path.resolve(input)),
        onProgress: cliProgressReporter(),
      });

      this.Log.success(`Rendered ${input} to pdf ${options.output}`);
    } catch (err) {
      this.Log.error(`Cannot render ${input} to pdf, reason: ${err.message}`);
      throw err;
    } finally {
      // one-shot CLI: close the pooled browser so the process can exit
      await renderer.dispose();
    }
  }

  private resolvePdfOptions(options: RenderPdfOptions) {
    return {
      format: (options.format ?? 'A4') as PaperFormat,
      landscape: !!options.landscape,
      printBackground: true,
      ...(options.scale && { scale: parseFloat(options.scale) }),
    };
  }
}
