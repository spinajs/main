import { Injectable } from '@spinajs/di';
import { HandleException, HTTP_STATUS_CODE, IResponseOptions, Response } from '@spinajs/http';
import { OrmNotFoundException } from '@spinajs/orm';

@HandleException([OrmNotFoundException])
@Injectable(Response)
export class OrmNotFound extends Response {
  protected _errorCode = HTTP_STATUS_CODE.NOT_FOUND;
  protected _template = 'notFound.pug';

  constructor(error: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(error, options);
  }
}
