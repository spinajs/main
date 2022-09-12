import { InvalidOperation } from '@spinajs/exceptions';
import { DI, AsyncModule, Inject } from '@spinajs/di';
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

  protected Renderers: Map<string, TemplateRenderer> = new Map<string, TemplateRenderer>();

  public async resolveAsync(): Promise<void> {
    const renderers = await DI.resolve(Array.ofType(TemplateRenderer));

    renderers.forEach((r) => {
      this.Log.info(`Registered template renderer ${r.Type} for extensions ${r.Extension}`);
      this.Renderers.set(r.Extension, r);
    });

    await super.resolveAsync();
  }

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
