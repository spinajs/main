import { Browser, default as puppeteer } from 'puppeteer';
import { NotSupported } from '@spinajs/exceptions';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, LazyInject } from '@spinajs/di';
import { basename, dirname, join } from 'path';
import { Log, Logger } from '@spinajs/log';
import Express from 'express';
import * as http from 'http';

import '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
export class PdfRenderer extends TemplateRenderer {
  @Config('templates.pdf')
  protected Options: any;

  @Logger('pdf-templates')
  protected Log: Log;

  @LazyInject()
  protected TemplatingService: Templates;

  public get Type() {
    return 'pdf';
  }

  public get Extension() {
    return '.pdf';
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    let server: http.Server = null;
    let browser: Browser = null;
    try {
      this.Log.timeStart(`pdf-template-rendering-${filePath}`);
      this.Log.trace(`Rendering pdf template ${template} to file ${filePath}`);

      const templateBasePath = dirname(template);

      const compiledTemplate = await this.TemplatingService.render(join(templateBasePath, basename(template, '.pdf')) + '.pug', model, language);

      // fire up local http server for serving images etc
      // becouse chromium prevents from reading local files when not
      // rendering file with file:// protocol for security reasons
      const app = Express();
      app.use(Express.static(compiledTemplate));
      server = app
        .listen(this.Options.static.port, () => {
          this.Log.trace(`PDF image server started`);
        })
        .on('error', (err: any) => {
          this.Log.error(err, `PDF image server cannot start`);
        });

      this.Log.trace(`PDF static file dir at ${compiledTemplate}`);

      browser = await puppeteer.launch(this.Options.args);
      const page = await browser.newPage();
      await page.setContent(compiledTemplate);
      await page.pdf({
        path: filePath,
        ...this.Options,
      });
    } catch (err) {
      this.Log.error(err, `Error rendering pdf template ${template} to file ${filePath}`);
      throw err;
    } finally {
      const duration = this.Log.timeEnd(`pdf-template-rendering-${filePath}`);
      this.Log.trace(`Ended rendering pdf template ${template} to file ${filePath}, took: ${duration}ms`);

      if (duration > this.Options.renderDurationWarning) {
        this.Log.warn(`Rendering pdf template ${template} to file ${filePath} took too long.`);
      }

      if (browser) {
        await browser.close();
      }

      if (server) {
        await server.close();
      }
    }
  }

  public async render(_templateName: string, _model: unknown, _language?: string): Promise<string> {
    throw new NotSupported('cannot render pdf template to string');
  }

  // no compilation at start
  protected async compile(_path: string) {}
}
