import { NotSupported, IOFail } from '@spinajs/exceptions';
import { TemplateRenderer, ensureParentDir } from '@spinajs/templates';
import { Injectable } from '@spinajs/di';
import { Renderer } from 'xlsx-renderer';
import * as fs from 'fs';

let renderId = 0;

@Injectable(TemplateRenderer)
export class XlsxRenderer extends TemplateRenderer {
  public get Type() {
    return 'xlsx';
  }

  public get Extension() {
    return '.xlsx';
  }

  public async renderToFile(template: string, model: unknown, filePath: string, _language?: string): Promise<void> {
    const localTemplate = await this.resolveLocalPath(template);
    if (!fs.existsSync(localTemplate)) {
      throw new IOFail(`File for template at path ${template} not exists`);
    }

    this.Log.trace({ template }, 'Rendering xlsx template ${template}');

    // unique per call: concurrent renders of one template must not share a timer
    const label = `XlsxTemplate.render.start.${template}.${++renderId}`;
    this.Log.timeStart(label);

    try {
      const renderer = new Renderer();
      const result = await renderer.renderFromFile(localTemplate, model);

      ensureParentDir(filePath);
      await result.xlsx.writeFile(filePath);
    } catch (err) {
      this.Log.timeEnd(label);
      throw err;
    }

    const time = this.Log.timeEnd(label);
    this.Log.trace({ template, time }, 'Rendering xlsx template ${template} ended, (${time} ms)');
  }

  public async render(_templateName: string, _model: unknown, _language?: string): Promise<string> {
    return Promise.reject(new NotSupported('Cannot render xlsx to memory'));
  }
}
