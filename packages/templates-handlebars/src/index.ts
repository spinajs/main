import { IOFail } from '@spinajs/exceptions';
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

  protected async compile(template: string): Promise<HandlebarsTemplateDelegate<any>> {
    // handlebars compiles from a string, so local paths and fs:// URIs are both
    // read to text first.
    const content = await this.resolveContent(template);

    if (content.length === 0) {
      throw new IOFail(`Template file ${template} is empty`);
    }

    const compiled = Handlebars.compile(content, this.Options);

    if (!compiled) {
      throw new IOFail(`Cannot compile handlebars template from path ${template}`);
    }

    return compiled;
  }

  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    // merge into a fresh object so the caller's model is never mutated
    return _.merge({}, model ?? {}, {
      lang: language,
    });
  }
}
