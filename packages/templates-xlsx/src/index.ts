import { NotSupported, IOFail } from '../../exceptions/lib/index.js';
import _ from 'lodash';
import { TemplateRenderer } from '@spinajs/templates';
import { Logger, Log } from '@spinajs/log';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { Renderer } from 'xlsx-renderer';
import * as fs from 'fs';

@Injectable(TemplateRenderer)
export class XlsxRenderer extends TemplateRenderer {
  @Logger('renderer')
  protected Log: Log;

  protected Templates: Map<string, string> = new Map<string, string>();

  @Config('templates.xlsx')
  protected Options: any;

  public get Type() {
    return 'xlsx';
  }

  public get Extension() {
    return '.xlsx';
  }

  public async resolve(): Promise<void> {
    await super.resolve();
  }

  public async renderToFile(template: string, model: unknown, filePath: string, _language?: string): Promise<void> {
    if (!this.Templates.has(template)) {
      throw new IOFail(`Cannot find template file ${template}`);
    }

    const tFile = this.Templates.get(template);

    if (!fs.existsSync(tFile)) {
      throw new IOFail(`File for template ${template} at path ${tFile} not exists`);
    }

    this.Log.trace(`Rendering xlsx template ${template}`);
    this.Log.timeStart(`XlsxTemplate.render.start.${template}`);

    const renderer = new Renderer();
    const result = await renderer.renderFromFile(this.Templates.get(template), model);

    await result.xlsx.writeFile(filePath);

    const time = this.Log.timeEnd(`XlsxTemplate.render.start.${template}`);
    this.Log.trace(`Rendering xlsx template ${template} ended, (${time} ms)`);
  }

  public async render(_templateName: string, _model: unknown, _language?: string): Promise<string> {
    return Promise.reject(new NotSupported('Cannot render xlsx to memory'));
  }

  protected compile(templateName: string, path: string): Promise<void> {
    // we cannot precompile xlsx files, just empty resolve
    // and add to template list

    this.Templates.set(templateName, path);

    return Promise.resolve();
  }
}
