import { IOFail } from '@spinajs/exceptions';
import * as fs from 'fs';
import _ from 'lodash';
import { CompiledTemplateRenderer, TemplateRenderer } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';
import Handlebars from 'handlebars';
import * as helpers from './helpers/index.js';

@Singleton()
@Injectable(TemplateRenderer)
export class HandlebarsRenderer extends CompiledTemplateRenderer<HandlebarsTemplateDelegate<any>> {
  @Config('templates.handlebars')
  protected Options: any;

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

  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    return _.merge({}, model ?? {}, {
      lang: language,
    });
  }

  protected async compile(path: string): Promise<void> {
    if (!fs.existsSync(path)) {
      throw new IOFail(`Template file ${path} does not exist`);
    }

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
