import { __translate, __translateNumber, __translateL, __translateH } from '@spinajs/intl';
import { IOFail } from '@spinajs/exceptions';
import * as pug from 'pug';
import _ from 'lodash';
import { CompiledTemplateRenderer, TemplateRenderer } from '@spinajs/templates';

import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

@Injectable(TemplateRenderer)
export class PugRenderer extends CompiledTemplateRenderer<pug.compileTemplate> {
  @Config('templates.pug')
  protected Options: pug.Options;

  public get Type() {
    return 'pug';
  }

  public get Extension() {
    return '.pug';
  }

  protected async compile(template: string): Promise<pug.compileTemplate> {
    // pug compiles from a path, not a string - it resolves include/extends
    // against the local filesystem itself, so remote fs:// sources are
    // materialised to temp storage first.
    const tPath = await this.resolveLocalPath(template);
    const compiled = pug.compileFile(tPath, this.Options);

    if (!compiled) {
      throw new IOFail(`Cannot compile pug template ${template} from path ${tPath}`);
    }

    return compiled;
  }

  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    // merge into a fresh object so the caller's model is never mutated
    return _.merge({}, model ?? {}, {
      __: __translate(language),
      __n: __translateNumber(language),
      __l: __translateL,
      __h: __translateH,
    });
  }
}
