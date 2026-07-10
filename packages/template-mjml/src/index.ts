import * as fs from 'fs';
import { TemplateRenderer, ensureParentDir } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, LazyInject } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import mjml2html from 'mjml';
import { MJMLParsingOptions } from 'mjml-core';

@Injectable(TemplateRenderer)
export class MjmlRenderer extends TemplateRenderer {
  @LazyInject(Templates)
  protected Templates: Templates;

  @Config('templates.mjml')
  protected Options: MJMLParsingOptions;

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
    const html = await mjml2html(mjmTemplate, this.Options);

    const time = this.Log.timeEnd(`MjmlRenderer.render.start.${templateName}`);
    this.Log.trace(`Rendering mjml template ${templateName} ended, (${time} ms)`);

    html.errors.forEach((error) => {
      this.Log.warn(`MJML error: ${error.formattedMessage}`);
    });
    
    return html.html;
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const content = await this.render(template, model, language);
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, content);
  }
}
