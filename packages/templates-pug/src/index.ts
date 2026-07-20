import { __translate, __translateNumber, __translateL, __translateH } from '@spinajs/intl';
import { IOFail } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as pugTemplate from 'pug';
import _ from 'lodash';
import { CompiledTemplateRenderer, TemplateRenderer } from '@spinajs/templates';

import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
@Injectable(TemplateRenderer)
export class PugRenderer extends TemplateRenderer {
  @Config('templates.pug')
  protected Options: pugTemplate.Options;

  constructor() {
    super();
  }

  public get Type() {
    return 'pug';
  }

  public get Extension() {
    return '.pug';
  }

  // in dev mode always recompile so template edits are picked up without a restart
  protected shouldRecompile(): boolean {
    return this.devMode;
  }

  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering pug template ${templateName}`);
    this.Log.timeStart(`PugTemplate.render.start.${templateName}`);

    if (!templateName) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    const fTemplate = await this.withCache(templateName, async () => {
      // pug compiles from a path, not a string - it resolves include/extends
      // against the local filesystem itself, so remote sources are materialised
      // to temp storage first.
      const tPath = await this.resolveLocalPath(templateName);
      const tCompiled = pugTemplate.compileFile(tPath, this.Options);

      if (!tCompiled) {
        throw new IOFail(`Cannot compile pug template ${templateName} from path ${tPath}`);
      }

      return tCompiled;
    });

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

    const time = this.Log.timeEnd(`PugTemplate.render.start.${templateName}`);
    this.Log.trace(`Rendering pug template ${templateName} ended, (${time} ms)`);

    return content;
  }
}
