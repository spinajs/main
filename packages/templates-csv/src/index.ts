import * as fs from 'fs';
import { AsyncParser } from '@json2csv/node';
import { TemplateRenderer, ensureParentDir } from '@spinajs/templates';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

export interface ICsvField {
  label?: string;
  value: string | ((row: any) => unknown);
  default?: string;
}

export interface IJsonToCsvOptions {
  fields: Array<string | ICsvField>;
  data: unknown;
}

@Injectable(TemplateRenderer)
export class Csv extends TemplateRenderer {
  @Config('templates.csv')
  protected Options: any;

  @Logger('csv-templates')
  protected Log: Log;


  public get Type() {
    return 'csv';
  }

  public get Extension() {
    return '.csv';
  }

  public async renderToFile(_template: string, model: IJsonToCsvOptions, filePath: string, language?: string): Promise<void> {

    this.Log.trace({ template: _template, filePath }, 'Rendering template ${template} to file ${filePath}');

    try {
      const csv = await this.render(_template, model, language);
      ensureParentDir(filePath);
      await fs.promises.writeFile(filePath, csv, 'utf8');
    } catch (err) {
      this.Log.error({ error: err, template: _template, filePath }, 'Error rendering template ${template} to file ${filePath}');
      throw err;
    } finally {
      this.Log.trace({ template: _template, filePath }, 'Ended rendering template ${template} to file ${filePath}');

    }
  }

  public async render(_templateName: string, model: IJsonToCsvOptions, _language?: string): Promise<string> {
    // fail fast with a clear message rather than an opaque TypeError from the parser
    if (!model || !Array.isArray(model.fields) || model.data == null) {
      throw new InvalidArgument('csv render model requires { fields: Array<string | ICsvField>, data }');
    }

    const parser = new AsyncParser({
      ...this.Options,
      fields: model.fields,
    });

    // todo: maybe use writable stream in future for large data sets
    return await parser.parse(model.data).promise();
  }
}
