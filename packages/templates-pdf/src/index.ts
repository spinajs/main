import { Browser, PDFOptions, default as puppeteer } from 'puppeteer';
import { NotSupported } from '@spinajs/exceptions';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { IInstanceCheck, Injectable, LazyInject, PerInstanceCheck } from '@spinajs/di';
import { basename, dirname, join } from 'path';
import { Log, Logger } from '@spinajs/log';
import Express from 'express';
import * as http from 'http';
import cors from 'cors';

import '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class PdfRenderer extends TemplateRenderer implements IInstanceCheck {
  /**
   * General options from configuration
   */
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

  constructor(protected pdfOptions: PDFOptions) {
    super();
  }

  __checkInstance__(creationOptions: any): boolean {
    return JSON.stringify(this.pdfOptions) === JSON.stringify(creationOptions);
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
      server = await this.runLocalServer(templateBasePath);

      browser = await puppeteer.launch(this.Options.args);
      const page = await browser.newPage();

      page
        .on('console', (message) => this.Log.trace(`${message.type().substr(0, 3).toUpperCase()} ${message.text()}`))
        .on('pageerror', ({ message }) => this.Log.error(message))
        .on('response', (response) => this.Log.trace(`${response.status()} ${response.url()}`))
        .on('requestfailed', (request) => this.Log.error(`${request.failure().errorText} ${request.url()}`));

      await page.setBypassCSP(true);
      await page.setContent(compiledTemplate);
      await page.pdf({
        path: filePath,
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

  protected async runLocalServer(basePath: string): Promise<http.Server> {
    const self = this;
    const app = Express();
    app.use(cors());
    app.use(Express.static(basePath));

    return new Promise((resolve, reject) => {
      app
        .listen(this.Options.static.port, function () {
          self.Log.trace(`PDF image server started`);
          self.Log.trace(`PDF static file dir at ${basePath}`);

          resolve(this);
        })
        .on('error', (err: any) => {
          self.Log.error(err, `PDF image server cannot start`);
          reject(err);
        });
    });
  }
}
