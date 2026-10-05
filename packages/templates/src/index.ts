import { InvalidOperation } from '@spinajs/exceptions';
import { AsyncService, Inject, Autoinject } from '@spinajs/di';
import { Log, Logger, Perf } from '@spinajs/log';
import { TemplateRenderer } from './interfaces.js';
import { IRenderOptions } from './progress.js';
import { extname } from 'path';
import { Intl } from '@spinajs/intl';
export * from './interfaces.js';
export * from './progress.js';
export * from './io.js';
export * from './CompiledTemplateRenderer.js';
export * from './cli/renderHelpers.js';

/** Same rules as `redactError` in `@spinajs/email`, which this package cannot depend on. */
function redactError(err: unknown, secrets: readonly string[]): unknown {
  const forms = [...new Set(secrets.filter((s) => s.length > 0).flatMap((s) => [s, encodeURIComponent(s)]))].sort((a, b) => b.length - a.length);
  if (forms.length === 0) {
    return err;
  }
  const redact = (text: string) => forms.reduce((t, s) => t.split(s).join('[redacted]'), text);
  const e = new Error(redact(err instanceof Error ? err.message : String(err)));
  e.name = redact(err instanceof Error ? err.name : 'Error');
  return e;
}

/** Redacts inside the span: Perf hands a failed span's error to every sink, and the log sink prints it. */
async function redacting<T>(options: IRenderOptions | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw options?.redact ? redactError(err, options.redact) : err;
  }
}

/**
 * Inject INTL module for language support. We does nothing but to initialize module for use in templates.
 */
@Inject(Intl)
export class Templates extends AsyncService {
  @Logger('templates')
  protected Log: Log;

  @Autoinject(TemplateRenderer)
  protected Renderers: TemplateRenderer[];

  public getRendererFor(extname: string): TemplateRenderer {
    return this.Renderers.find((x) => x.Extension === extname)!;
  }

  public async compileToFile(template: string, renderer: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    const engine = this.engineByType(renderer);
    return await Perf.measure('template.compile', () => redacting(options, () => engine.renderToFile(template, model, filePath, language, options)), { labels: { engine: engine.Type }, fields: { template } });
  }

  /**
   *
   * Renders template with given model and language. Returns compiled content
   *
   * @param template
   * @param renderer
   * @param model
   * @param language
   * @param options - optional render options (e.g. progress reporting)
   * @returns
   */
  public async compile(template: string, renderer: string, model: unknown, language?: string, options?: IRenderOptions): Promise<string> {
    const engine = this.engineByType(renderer);
    return await Perf.measure('template.compile', () => redacting(options, () => engine.render(template, model, language, options)), { labels: { engine: engine.Type }, fields: { template } });
  }

  /**
   *
   * Renders template with given model and language. Returns compiled content
   * It detects automatically renderer based on file extension
   *
   * @param template
   * @param model
   * @param language
   * @param options - optional render options (e.g. progress reporting)
   * @returns
   */
  public async render(template: string, model: unknown, language?: string, options?: IRenderOptions): Promise<string> {
    const renderer = this.engineByExtension(template);
    return await Perf.measure('template.render', () => redacting(options, () => renderer.render(template, model, language, options)), { labels: { engine: renderer.Type }, fields: { template } });
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    const renderer = this.engineByExtension(template);
    return await Perf.measure('template.render', () => redacting(options, () => renderer.renderToFile(template, model, filePath, language, options)), { labels: { engine: renderer.Type }, fields: { template } });
  }

  /**
   * Finds the renderer registered under the given renderer type (e.g. `handlebars`,
   * `pdf`), throwing if none is registered.
   */
  private engineByType(renderer: string): TemplateRenderer {
    const engine = this.Renderers.find((x) => x.Type === renderer);
    if (!engine) {
      throw new InvalidOperation(`No renderer for ${renderer}`);
    }

    return engine;
  }

  /**
   * Finds the renderer matching the template file's extension, throwing if none
   * is registered for that extension.
   */
  private engineByExtension(template: string): TemplateRenderer {
    const extension = extname(template);
    const renderer = this.Renderers.find((x) => x.Extension === extension);
    if (!renderer) {
      throw new InvalidOperation(`No renderer for file ${template} with extension ${extension}`);
    }

    return renderer;
  }
}
