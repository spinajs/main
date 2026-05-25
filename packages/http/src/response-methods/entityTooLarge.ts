import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { HandleException } from '../decorators.js';
import { EntityTooLargeException } from '../exceptions.js';
import { Injectable } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 413 ENTITY TOO LARGE
 * @param data - additional data eg. model pk
 */
@HandleException(EntityTooLargeException)
@Injectable(Response)
export class EntityTooLarge<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.ENTITY_TOO_LARGE;
  protected _template = 'entityTooLarge.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
