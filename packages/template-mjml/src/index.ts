import * as fs from 'fs';
import { isAbsolute, resolve } from 'path';
import { TemplateRenderer, ensureParentDir, IRenderOptions } from '@spinajs/templates';
import '@spinajs/templates-handlebars';
import { Config } from '@spinajs/configuration';
import { Injectable, LazyInject } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import mjml2html from 'mjml';
import { MJMLParsingOptions } from 'mjml-core';

@Injectable(TemplateRenderer)
export class MjmlRenderer extends TemplateRenderer {
  @LazyInject(Templates)
  protected Templates: Templates;

  private static TimerId = 0;

  @Config('templates.mjml')
  protected Options: MJMLParsingOptions;

  public get Type() {
    return 'mjml';
  }

  public get Extension() {
    return '.mjml';
  }

  public async render(templateName: string, model: unknown, language?: string, options?: IRenderOptions): Promise<string> {
    this.Log.trace({ templateName }, 'Rendering mjml template ${templateName}');
    const timer = `MjmlRenderer.render.start.${templateName}.${++MjmlRenderer.TimerId}`;
    this.Log.timeStart(timer);

    let html: Awaited<ReturnType<typeof mjml2html>>;
    let time: number;
    try {
      const mjmTemplate = await this.Templates.compile(templateName, 'handlebars', model, language, options);
      html = await mjml2html(mjmTemplate, this.mjmlOptions(templateName));
    } finally {
      time = this.Log.timeEnd(timer);
    }

    this.Log.trace({ templateName, time }, 'Rendering mjml template ${templateName} ended, (${time} ms)');

    html.errors.forEach((error) => {
      this.Log.warn({ mjmlError: error.formattedMessage }, 'MJML error: ${mjmlError}');
    });

    return html.html;
  }

  /** Relative mj-include paths resolve against the template's folder unless `filePath` is configured. Only local templates have a folder. */
  private mjmlOptions(templateName: string): MJMLParsingOptions {
    if (this.Options?.filePath || templateName.includes('://')) {
      return this.Options;
    }

    const path = isAbsolute(templateName) ? templateName : resolve(process.cwd(), templateName);
    return { ...this.Options, filePath: path };
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    const content = await this.render(template, model, language, options);
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, content);
  }
}
