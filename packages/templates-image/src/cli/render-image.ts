import { ImageRenderer } from './../index.js';
import { cliProgressReporter, ensureParentDir, resolveInputHtml } from '@spinajs/templates';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import * as path from 'path';
import { Logger, Log } from '@spinajs/log-common';

const IMAGE_TYPES = ['png', 'jpeg', 'webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

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
@Option('-o, --output <file>', true, 'output image file path (.png / .jpeg / .webp)')
@Option('-t, --template', false, 'treat input as a template rendered via the engine instead of raw HTML')
@Option('-m, --model [model]', false, 'path to a JSON model file (template mode only)')
@Option('-l, --lang [lang]', false, 'optional language (template mode only)')
@Option('--width [width]', false, 'viewport width in px (for deterministic captures)')
@Option('--height [height]', false, 'viewport height in px (for deterministic captures)')
@Option('--scale [scale]', false, 'device scale factor / DPI multiplier (default 1)')
@Option('--type [type]', false, 'image type: png (default), jpeg (jpg) or webp; inferred from --output when omitted')
export class RenderImageCommand extends CliCommand {
  @Logger('templates-image')
  protected Log: Log;

  public async execute(input: string, options: RenderImageOptions): Promise<void> {
    const type = this.resolveType(options);
    const renderer = await DI.resolve(ImageRenderer, [{ type }]);

    try {
      this.Log.trace({ input, output: options.output, options }, 'Rendering ${input} to image ${output}, options: ${options}');

      const html = await resolveInputHtml(input, options);

      ensureParentDir(options.output);

      await renderer.renderHtmlToFile(html, options.output, {
        assetBasePath: path.dirname(path.resolve(input)),
        viewport: this.resolveViewport(options),
        onProgress: cliProgressReporter(),
      });

      this.Log.success({ input, output: options.output }, 'Rendered ${input} to image ${output}');
    } catch (err) {
      this.Log.error({ error: err, input }, 'Cannot render ${input} to image');
      throw err;
    } finally {
      // one-shot CLI: close the pooled browser so the process can exit
      await renderer.dispose();
    }
  }

  private resolveType(options: RenderImageOptions): ImageType {
    const normalize = (value: string) => {
      const v = value.toLowerCase();
      return v === 'jpg' ? 'jpeg' : v;
    };

    const requested = options.type ? normalize(options.type) : normalize(path.extname(options.output).slice(1) || 'png');
    if (!IMAGE_TYPES.includes(requested as ImageType)) {
      throw new InvalidArgument(`Unsupported image type '${options.type ?? path.extname(options.output)}', expected one of: ${IMAGE_TYPES.join(', ')}`);
    }

    return requested as ImageType;
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
