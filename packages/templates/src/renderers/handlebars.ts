import { IOFail } from './../../../exceptions/src/index';
import { __translate, __translateNumber, __translateL, __translateH, guessLanguage, defaultLanguage } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as path from 'path';
import _ from 'lodash';
import { TemplateRenderer } from '../interfaces';
import { Logger, Log } from '@spinajs/log';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import * as Handlebars from 'handlebars';

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

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const content = await this.render(template, model, language);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content);
  }

  public async render(templatePath: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering template ${templatePath}`);
    this.Log.timeStart(`HandlebarTemplate${templatePath}`);

    if (!templatePath) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    const fTemplate = this.Templates.get(templatePath);

    const lang = language ? language : guessLanguage();
    const tLang = lang ?? defaultLanguage();

    const content = fTemplate(
      _.merge(model ?? {}, {
        __: __translate(tLang),
        __n: __translateNumber(tLang),
        __l: __translateL,
        __h: __translateH,
      }),
    );

    const time = this.Log.timeEnd(`HandlebarTemplate-${templatePath}`);
    this.Log.trace(`Rendering template ${templatePath} ended, (${time} ms)`);

    return Promise.resolve(content);
  }

  protected async compile(templateName: string, path: string): Promise<void> {
    const tContent = fs.readFileSync(path);
    const tCompiled = Handlebars.compile(tContent, this.Options);

    if (!tCompiled) {
      throw new IOFail(`Cannot compile handlebars template ${templateName} from path ${path}`);
    }

    this.Templates.set(templateName, tCompiled);
  }
}
