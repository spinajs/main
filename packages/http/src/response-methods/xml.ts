import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response, ResponseFunction } from '../interfaces.js';
import { xmlResponse } from '../responses.js';

/**
 * Returns an HTTP 200 response with an XML body, bypassing Accept-header
 * negotiation. Use when the endpoint must always respond with XML. The data
 * should be a plain object graph; arrays / scalars are wrapped under a
 * `<response>` root. Optional fast-xml-parser XMLBuilder options can be passed.
 */
export class Xml<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.OK;
  protected _template = '';

  constructor(data?: T | Promise<T> | null, protected options?: IResponseOptions, protected xmlOptions?: any) {
    super(data, options);
  }

  public async execute(_req: express.Request, _res: express.Response): Promise<ResponseFunction | void> {
    const data = await this.prepareResponse();
    return xmlResponse(data, { ...this.options, StatusCode: this.options?.StatusCode ?? this._errorCode }, this.xmlOptions);
  }
}
