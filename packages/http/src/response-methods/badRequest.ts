import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import _ from 'lodash';
import { ExpectedResponseUnacceptable, InvalidArgument, BadRequest } from '@spinajs/exceptions';
import { HandleException } from '../decorators.js';
import { Injectable } from '@spinajs/di';

@HandleException([InvalidArgument, BadRequest, ExpectedResponseUnacceptable])
@Injectable(Response)
export class BadRequestResponse extends Response {
  protected _errorCode = HTTP_STATUS_CODE.BAD_REQUEST;
  protected _template = 'badRequest.pug';

  constructor(error: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(error, options);
  }
}
