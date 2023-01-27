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

  @Autoinject(TemplateRenderer, {
    mapFunc: (x) => x.ServiceName,
  })
  protected Renderers: Map<string, TemplateRenderer>;

  public async render(template: string, model: unknown, language?: string): Promise<string> {
    const extension = extname(template);
    if (!this.Renderers.has(extension)) {
      throw new InvalidOperation(`No renderer for file ${template} with extension ${extension}`);
    }

    return await this.Renderers.get(extension).render(template, model, language);
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const extension = extname(template);
    if (!this.Renderers.has(extension)) {
      throw new InvalidOperation(`No renderer for file ${template} with extension ${extension}`);
    }

    return await this.Renderers.get(extension).renderToFile(template, model, filePath, language);
  }
}
