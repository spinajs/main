import { __translate, __translateNumber, __translateL, __translateH } from '@spinajs/intl';
import { IOFail } from '@spinajs/exceptions';
import * as fs from 'fs';
import * as pugTemplate from 'pug';
import _ from 'lodash';
import { CompiledTemplateRenderer, TemplateRenderer } from '@spinajs/templates';

import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { normalize } from 'path';
@Injectable(TemplateRenderer)
export class PugRenderer extends CompiledTemplateRenderer<pugTemplate.compileTemplate> {
  @Config('templates.pug')
  protected Options: pugTemplate.Options;

  @Config('configuration.isDevelopment')
  protected devMode: boolean;

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

  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    return _.merge({}, model ?? {}, {
      __: __translate(language),
      __n: __translateNumber(language),
      __l: __translateL,
      __h: __translateH,
    });
  }

  protected async compile(path: string) {
    if (!fs.existsSync(path)) {
      throw new IOFail(`Template file ${path} does not exist`);
    }

    const tCompiled = pugTemplate.compileFile(path, this.Options);
    const pNormalized = normalize(path);

    if (!tCompiled) {
      throw new IOFail(`Cannot compile pug template ${pNormalized} from path ${path}`);
    }

    this.Templates.set(pNormalized, tCompiled);
  }
}
