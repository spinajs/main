import { __translate, __translateNumber, __translateL, __translateH, guessLanguage, defaultLanguage } from '@spinajs/intl';
import { IOFail, InvalidArgument } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as pugTemplate from 'pug';
import * as path from 'path';
import _ from 'lodash';
import { TemplateRenderer } from '../interfaces';

import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

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

  public async render(template: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering template ${template}`);
    this.Log.timeStart(`PugTemplate${template}`);

    if (!template) {
      throw new InvalidArgument('template parameter cannot be null or empty');
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

    const time = this.Log.timeEnd(`PugTemplate${template}`);
    this.Log.trace(`Rendering template ${template} ended, (${time} ms)`);

    return Promise.resolve(content);
  }

  protected async compile(templateName: string, path: string) {
    const tCompiled = pugTemplate.compileFile(path, this.Options);

    if (!tCompiled) {
      throw new IOFail(`Cannot compile handlebars template ${templateName} from path ${path}`);
    }

    this.Templates.set(templateName, tCompiled);
  }
}
