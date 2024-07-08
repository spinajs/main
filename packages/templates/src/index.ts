import { InvalidOperation } from '@spinajs/exceptions';
import { AsyncService, Inject, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { TemplateRenderer } from './interfaces.js';
import { extname } from 'path';
import { Intl } from '@spinajs/intl';
export * from './interfaces.js';

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
    return this.Renderers.find((x) => x.Extension === extname);
  }

  public async compileToFile(template: string, renderer: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const engine = this.Renderers.find((x) => x.Type === renderer);
    if (!engine) {
      throw new InvalidOperation(`No renderer for ${renderer}`);
    }

    return await engine.renderToFile(template, model, filePath, language);
  }

  /**
   * 
   * Renders template with given model and language. Returns compiled content
   * 
   * @param template 
   * @param renderer 
   * @param model 
   * @param language 
   * @returns 
   */
  public async compile(template: string, renderer: string, model: unknown, language?: string): Promise<string> {
    const engine = this.Renderers.find((x) => x.Type === renderer);
    if (!engine) {
      throw new InvalidOperation(`No renderer for ${renderer}`);
    }

    return await engine.render(template, model, language);
  }

  /**
   * 
   * Renders template with given model and language. Returns compiled content
   * It detects automatically renderer based on file extension
   * 
   * @param template 
   * @param model 
   * @param language 
   * @returns 
   */
  public async render(template: string, model: unknown, language?: string): Promise<string> {
    const extension = extname(template);
    const renderer = this.Renderers.find((x) => x.Extension === extension);

    if (!renderer) {
      throw new InvalidOperation(`No renderer for file ${template} with extension ${extension}`);
    }

    return await renderer.render(template, model, language);
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const extension = extname(template);
    const renderer = this.Renderers.find((x) => x.Extension === extension);

    if (!renderer) {
      throw new InvalidOperation(`No renderer for file ${template} with extension ${extension}`);
    }

    return await renderer.renderToFile(template, model, filePath, language);
  }
}
