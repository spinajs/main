import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import _ from 'lodash';
import { ExpectedResponseUnacceptable, InvalidArgument, BadRequest } from '@spinajs/exceptions';
import { HandleException } from '../decorators.js';
import { Injectable } from '@spinajs/di';

@HandleException([InvalidArgument, BadRequest, ExpectedResponseUnacceptable])
@Injectable(Response)
export class BadRequestResponse<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.BAD_REQUEST;
  protected _template = 'badRequest.pug';

  constructor(error: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(error, options);
  }
}
