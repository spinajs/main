import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { HandleException } from '../decorators.js';
import { UnsupportedMediaTypeException } from '../exceptions.js';
import { Injectable } from '@spinajs/di';

/**
 * Returns HTTP 415 UNSUPPORTED MEDIA TYPE
 * @param data - error to send
 */
@HandleException(UnsupportedMediaTypeException)
@Injectable(Response)
export class UnsupportedMediaType<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.UNSUPPORTED_MEDIA_TYPE;
  protected _template = 'unsupported-media-type.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
