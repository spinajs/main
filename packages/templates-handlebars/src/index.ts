import { IOFail } from '@spinajs/exceptions';
import { guessLanguage, defaultLanguage } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as path from 'path';
import _ from 'lodash';
import { TemplateRenderer } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';
import Handlebars from 'handlebars';
import { normalize } from 'path';
import * as helpers from './helpers/index.js';

@Singleton()
@Injectable(TemplateRenderer)
export class HandlebarsRenderer extends TemplateRenderer {
  @Config('templates.handlebars')
  protected Options: any;

  protected Templates: Map<string, HandlebarsTemplateDelegate<any>> = new Map<string, HandlebarsTemplateDelegate<any>>();

  public get Type() {
    return 'handlebars';
  }

  public get Extension() {
    return '.handlebars';
  }

  public async resolve(): Promise<void> {
    // Register all helpers dynamically
    Object.keys(helpers).forEach((helperName) => {
      const helper = (helpers as any)[helperName];
      if (typeof helper === 'function') {
        Handlebars.registerHelper(helperName, helper);
      }
    });

    await super.resolve();
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const content = await this.render(template, model, language);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content);
  }

  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering template ${templateName}`);
    this.Log.timeStart(`HandlebarTemplate${templateName}`);

    if (!templateName) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    let fTemplate = null;
    if (!this.Templates.has(normalize(templateName))) {
      await this.compile(normalize(templateName));
    }

    fTemplate = this.Templates.get(normalize(templateName));

    const lang = language ? language : guessLanguage();
    const tLang = lang ?? defaultLanguage();

    const content = fTemplate(
      _.merge(model ?? {}, {
        lang: tLang,
      }),
    );

    const time = this.Log.timeEnd(`HandlebarTemplate-${templateName}`);
    this.Log.trace(`Rendering template ${templateName} ended, (${time} ms)`);

    return Promise.resolve(content);
  }

  protected async compile(path: string): Promise<void> {
    const tContent = fs.readFileSync(path, 'utf-8');

    if (tContent.length === 0) {
      throw new IOFail(`Template file ${path} is empty`);
    }

    const tCompiled = Handlebars.compile(tContent, this.Options);

    if (!tCompiled) {
      throw new IOFail(`Cannot compile handlebars template from path ${path}`);
    }

    this.Templates.set(path, tCompiled);
  }
}
