import { InvalidOperation } from '@spinajs/exceptions';
import { AsyncModule, Inject, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { TemplateRenderer } from './interfaces';
import { extname } from 'path';
import { Intl } from '@spinajs/intl';
export * from './interfaces';

/**
 * Inject INTL module for language support. We does nothing but to initialize module for use in templates.
 */
@Inject(Intl)
export class Templates extends AsyncModule {
  @Logger('templates')
  protected Log: Log;

  @Autoinject(TemplateRenderer, (x) => x.Extension)
  protected Renderers: Map<string, TemplateRenderer>;

  public async render(templatePath: string, model: unknown, language?: string): Promise<string> {
    const extension = extname(templatePath);
    if (!this.Renderers.has(extension)) {
      throw new InvalidOperation(`No renderer for file ${templatePath} with extension ${extension}`);
    }

    return await this.Renderers.get(extension).render(templatePath, model, language);
  }

  public async renderToFile(templatePath: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const extension = extname(templatePath);
    if (!this.Renderers.has(extension)) {
      throw new InvalidOperation(`No renderer for file ${templatePath} with extension ${extension}`);
    }

    return await this.Renderers.get(extension).renderToFile(templatePath, model, filePath, language);
  }
}
