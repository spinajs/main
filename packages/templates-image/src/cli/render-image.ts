import { ImageRenderer } from './../index.js';
import { Templates } from '@spinajs/templates';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import * as path from 'path';
import * as fs from 'fs';
import { Logger, Log } from '@spinajs/log-common';

interface RenderImageOptions {
  output: string;
  template?: boolean;
  model?: string;
  lang?: string;
  width?: string;
  height?: string;
  scale?: string;
  type?: string;
}

@Command('render-image', 'Render an HTML file (or a template) to a screenshot image - useful in CI for visual comparison')
@Argument('input', true, 'path to an .html file, or a template file when --template is set')
@Option('-o, --output <file>', true, 'output image file path (.png / .jpeg)')
@Option('-t, --template', false, 'treat input as a template rendered via the engine instead of raw HTML')
@Option('-m, --model [model]', false, 'path to a JSON model file (template mode only)')
@Option('-l, --lang [lang]', false, 'optional language (template mode only)')
@Option('--width [width]', false, 'viewport width in px (for deterministic captures)')
@Option('--height [height]', false, 'viewport height in px (for deterministic captures)')
@Option('--scale [scale]', false, 'device scale factor / DPI multiplier (default 1)')
@Option('--type [type]', false, 'image type: png (default) or jpeg')
export class RenderImageCommand extends CliCommand {
  @Logger('templates-image')
  protected Log: Log;

  public async execute(input: string, options: RenderImageOptions): Promise<void> {
    const type = options.type === 'jpeg' ? 'jpeg' : 'png';
    const renderer = await DI.resolve(ImageRenderer, [{ type }]);

    try {
      this.Log.trace(`Rendering ${input} to image ${options.output}, options: ${JSON.stringify(options)}`);

      const html = await this.resolveHtml(input, options);

      const outDir = path.dirname(options.output);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      await renderer.renderHtmlToFile(html, options.output, {
        assetBasePath: path.dirname(path.resolve(input)),
        viewport: this.resolveViewport(options),
      });

      this.Log.success(`Rendered ${input} to image ${options.output}`);
    } catch (err) {
      this.Log.error(`Cannot render ${input} to image, reason: ${err.message}`);
      throw err;
    } finally {
      // one-shot CLI: close the pooled browser so the process can exit
      await renderer.dispose();
    }
  }

  /**
   * Raw-HTML mode reads the file as-is; template mode renders it through the
   * text renderer (pug/handlebars/...) selected by the input file extension.
   */
  private async resolveHtml(input: string, options: RenderImageOptions): Promise<string> {
    if (options.template) {
      let model = {};
      if (options.model && fs.existsSync(options.model)) {
        model = JSON.parse(fs.readFileSync(options.model, { encoding: 'utf-8' }));
      }

      const templates = await DI.resolve(Templates);
      return templates.render(input, model, options.lang);
    }

    if (!fs.existsSync(input)) {
      throw new Error(`Input HTML file ${input} does not exist`);
    }

    return fs.readFileSync(input, { encoding: 'utf-8' });
  }

  private resolveViewport(options: RenderImageOptions) {
    if (!options.width && !options.height && !options.scale) {
      return undefined;
    }

    return {
      width: options.width ? parseInt(options.width, 10) : 800,
      height: options.height ? parseInt(options.height, 10) : 600,
      deviceScaleFactor: options.scale ? parseFloat(options.scale) : 1,
    };
  }
}
