import { InvalidOperation } from '@spinajs/exceptions';
import { AsyncService, Inject, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { TemplateRenderer } from './interfaces.js';
import { IRenderOptions } from './progress.js';
import { extname } from 'path';
import { Intl } from '@spinajs/intl';
export * from './interfaces.js';
export * from './progress.js';
export * from './io.js';
export * from './CompiledTemplateRenderer.js';
export * from './cli/renderHelpers.js';

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
    return await this.engineByType(renderer).renderToFile(template, model, filePath, language, options);
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
    return await this.engineByType(renderer).render(template, model, language, options);
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
    return await this.engineByExtension(template).render(template, model, language, options);
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    return await this.engineByExtension(template).renderToFile(template, model, filePath, language, options);
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
