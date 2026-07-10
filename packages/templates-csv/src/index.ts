import * as fs from 'fs';
import { AsyncParser } from '@json2csv/node';
import { TemplateRenderer, ensureParentDir } from '@spinajs/templates';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

export interface IJsonToCsvOptions {
  fields: string[];
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

    this.Log.trace(`Rendering template ${_template} to file ${filePath}`);

    try {
      const csv = await this.render(_template, model, language);
      ensureParentDir(filePath);
      fs.writeFileSync(filePath, csv, 'utf8');
    } catch (err) {
      this.Log.error(err, `Error rendering template ${_template} to file ${filePath}`);
      throw err;
    } finally {
      this.Log.trace(`Ended rendering template ${_template} to file ${filePath}`);

    }
  }

  public async render(_templateName: string, model: IJsonToCsvOptions, _language?: string): Promise<string> {
    // fail fast with a clear message rather than an opaque TypeError from the parser
    if (!model || !Array.isArray(model.fields) || model.data == null) {
      throw new InvalidArgument('csv render model requires { fields: string[], data }');
    }

    const parser = new AsyncParser({
      fields: model.fields,
      ...this.Options
    });

    // todo: maybe use writable stream in future for large data sets
    return await parser.parse(model.data).promise();
  }
}
