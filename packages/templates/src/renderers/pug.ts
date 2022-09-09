import { __translate, __translateNumber, __translateL, __translateH, guessLanguage, defaultLanguage } from '@spinajs/intl';
import { IOFail, InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as pugTemplate from 'pug';
import * as path from 'path';
import _ from 'lodash';
import { TemplateRenderer } from '../interfaces';

import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { normalize } from 'path';

@Injectable(TemplateRenderer)
export class PugRenderer extends TemplateRenderer {
  @Config('templates.pug')
  protected Options: pugTemplate.Options;

  protected Templates: Map<string, pugTemplate.compileTemplate> = new Map<string, pugTemplate.compileTemplate>();

  public get Type() {
    return 'pug';
  }

  public get Extension() {
    return '.pug';
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
    this.Log.timeStart(`PugTemplate${templateName}`);

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
        __: __translate(tLang),
        __n: __translateNumber(tLang),
        __l: __translateL,
        __h: __translateH,
      }),
    );

    const time = this.Log.timeEnd(`PugTemplate${templateName}`);
    this.Log.trace(`Rendering template ${templateName} ended, (${time} ms)`);

    return Promise.resolve(content);
  }

  protected async compile(templateName: string, path: string) {
    const tCompiled = pugTemplate.compileFile(path, this.Options);
    const pNormalized = normalize(templateName);

    if (!tCompiled) {
      throw new IOFail(`Cannot compile handlebars template ${pNormalized} from path ${path}`);
    }

    this.Templates.set(pNormalized, tCompiled);
  }
}
