import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import _ from 'lodash';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

export class BadRequest extends Response {
  constructor(error: any, protected options?: IResponseOptions) {
    super(error);

    const isDev = DI.get(Configuration).get('configuration.isDevelopment');
    if (!isDev) {
      this.responseData = _.omit(this.responseData, ['stack']);
    }
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, 'badRequest.pug', {
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.BAD_REQUEST,
    });
  }
}
