import { DI } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { fs } from '@spinajs/fs';
import * as express from 'express';
import _ from 'lodash';
import { HTTP_STATUS_CODE, IResponseOptions, ITemplateResponseOptions, Response } from '../interfaces.js';
import { htmlResponse } from '../responses.js';

/**
 * HTML resposne with HTML from pug file
 */
export class TemplateResponse extends Response {
  protected file: string;

  protected fsTemplates: fs;
  protected templateFile: string | ITemplateResponseOptions;

  constructor(file: string | ITemplateResponseOptions, model: object | Promise<unknown>, protected options? : IResponseOptions) {
    super(model);

    this.fsTemplates = _.isString(file)
      ? DI.resolve<fs>('__file_provider__', ['__fs_http_templates__'])
      : DI.resolve<fs>('__file_provider__', [file.provider]);

    this.templateFile = file;
  }

  public async execute(_req: express.Request, _res: express.Response) {

    const response = await this.prepareResponse();
    
    if (!this.fsTemplates) {
      const provider = _.isString(this.templateFile) ? '__fs_http_templates__' : this.templateFile.provider;
      throw new IOFail(`Cannot find template file provider ${provider}. Please check configuration for provider or make sure that __fs_http_templates__ is configured.`)
    }

    this.file = _.isString(this.templateFile)
      ? await this.fsTemplates.download(this.templateFile)
      : await this.fsTemplates.download(this.templateFile.template);

    return await htmlResponse(this.file, response, {
      ...this.options,
      StatusCode: this.options?.StatusCode ? this.options.StatusCode : HTTP_STATUS_CODE.OK
    });
  }
}
