import { __translate, __translateNumber, __translateL, __translateH, guessLanguage, defaultLanguage } from '@spinajs/intl';
import { IOFail, InvalidArgument } from '@spinajs/exceptions';
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

  public async render(template: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering template ${template}`);
    this.Log.timeStart(`HandlebarTemplate${template}`);

    if (!template) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    if (!this.Templates.has(template)) {
      this.Log.trace(`Template ${template} is used first time, compiling template ...`);

      const tFile = this.TemplateFiles.find((f) => f.endsWith(template));
      if (!tFile) {
        throw new IOFail(`Template file ${template} not exists`);
      }

      const cTemplate = fs.readFileSync(tFile);
      this.Templates.set(template, Handlebars.compile(cTemplate, this.Options));
    }

    const fTemplate = this.Templates.get(template);

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

    const time = this.Log.timeEnd(`HandlebarTemplate${template}`);
    this.Log.trace(`Rendering template ${template} ended, (${time} ms)`);

    return Promise.resolve(content);
  }
}
