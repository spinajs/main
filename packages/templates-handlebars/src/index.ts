import { IOFail, InvalidOperation } from '@spinajs/exceptions';
import { __translate, __translateNumber, __translateL, __translateH, guessLanguage, defaultLanguage } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as path from 'path';
import _ from 'lodash';
import { TemplateRenderer } from '@spinajs/templates';
import { Logger, Log } from '@spinajs/log';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import * as Handlebars from 'handlebars';
import { normalize } from 'path';

@Injectable(TemplateRenderer)
export class HandlebarsRenderer extends TemplateRenderer {
  @Logger('renderer')
  protected Log: Log;

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
    Handlebars.registerHelper('__', (context, options) => {
      return __translate(options.data.root.lang)(context);
    });

    Handlebars.registerHelper('__n', (context, count, options) => {
      return __translateNumber(options.data.root.lang)(context, count);
    });

    Handlebars.registerHelper('__l', (context) => {
      return __translateL(context);
    });

    Handlebars.registerHelper('__h', (context) => {
      return __translateH(context);
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

    const fTemplate = this.Templates.get(normalize(templateName));
    if (!fTemplate) {
      throw new InvalidOperation(`Template ${templateName} is not found ( check if exists & compiled )`);
    }

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

  protected async compile(templateName: string, path: string): Promise<void> {
    const tContent = fs.readFileSync(path, 'utf-8');

    if (tContent.length === 0) {
      throw new IOFail(`Template file ${path} is empty`);
    }

    const tCompiled = Handlebars.compile(tContent, this.Options);

    if (!tCompiled) {
      throw new IOFail(`Cannot compile handlebars template ${templateName} from path ${path}`);
    }

    this.Templates.set(templateName, tCompiled);
  }
}
