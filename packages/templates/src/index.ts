import { InvalidOperation } from './../../exceptions/src/index';
import { DI } from '@spinajs/di';
import { AsyncModule } from './../../di/src/interfaces';
import { TemplateRenderer } from './interfaces';
import { extname } from 'path';
import { Log, Logger } from '@spinajs/log';
export * from './interfaces';
export * from './renderers/handlebars';
export * from './renderers/pug';

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
