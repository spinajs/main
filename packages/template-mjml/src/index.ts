import { __translate, __translateNumber, __translateL, __translateH } from '@spinajs/intl';
import * as fs from 'fs';
import * as path from 'path';
import _ from 'lodash';
import { TemplateRenderer } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, LazyInject } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import mjml2html from 'mjml';
import { MJMLParsingOptions } from 'mjml-core';

@Injectable(TemplateRenderer)
export class MjmlRenderer extends TemplateRenderer {
  @Config('configuration.isDevelopment')
  protected devMode: boolean;

  @LazyInject(Templates)
  protected Templates: Templates;

  @Config('templates.mjml')
  protected Options: MJMLParsingOptions;

  constructor() {
    super();
  }

  public get Type() {
    return 'mjml';
  }

  public get Extension() {
    return '.mjml';
  }

  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering mjml template ${templateName}`);
    this.Log.timeStart(`MjmlRenderer.render.start.${templateName}`);

    const mjmTemplate = await this.Templates.compile(templateName, 'handlebars', model, language);
    const html = mjml2html(mjmTemplate, this.Options);

    const time = this.Log.timeEnd(`MjmlRenderer.render.start.${templateName}`);
    this.Log.trace(`Rendering mjml template ${templateName} ended, (${time} ms)`);

    if (html.errors.length > 0) {
      html.errors.forEach((error) => {
        this.Log.error(`MJML error: ${error.formattedMessage}`);
      });

      return;
    }

    return html.html;
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const content = await this.render(template, model, language);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content);
  }

  protected async compile(_templateName: string, _path: string): Promise<void> {}
}
