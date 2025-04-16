import { IOFail } from '@spinajs/exceptions';
import { __translate, __translateNumber, __translateL, __translateH, guessLanguage, defaultLanguage } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as path from 'path';
import _ from 'lodash';
import { TemplateRenderer } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';
import Handlebars from 'handlebars';
import { normalize } from 'path';

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

    Handlebars.registerHelper('__textRight', (context: string, length) => {
      if (context.length > length) {
        return context.substring(0, length);
      }
      return context.padStart(length, ' ');
    });

    Handlebars.registerHelper('__textCenter', (context: string, length) => {
      if (context.length > length) {
        return context.substring(0, length);
      } else if (context.length == length) {
        return context;
      } else {
        const leftPadding = (length - context.length) / 2;
        return context.padStart(leftPadding + context.length, ' ').padEnd(length, ' ');
      }
    });

    Handlebars.registerHelper('isOdd', function (index) {
      return index % 2 !== 0;
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
