import * as express from 'express';
import { InvalidArgument } from '@spinajs/exceptions';
import { HTTP_STATUS_CODE, IResponseOptions, Response, ResponseFunction } from '../interfaces.js';
// import from the defining module, not the package barrel ( see file.ts: the barrel re-forms an import cycle )
import { _setCoockies, _setHeaders } from '../responses.js';

/**
 * Sends bytes that already live in memory ( e.g. a rendered PNG ) as the response body,
 * bypassing Accept-header negotiation. Use FileResponse for files on an fs provider.
 */
export class BufferResponse extends Response<Buffer> {
  protected _errorCode = HTTP_STATUS_CODE.OK;
  protected _template = '';

  protected Bytes: Buffer;

  constructor(bytes: Buffer | Uint8Array, protected MimeType: string, options?: IResponseOptions) {
    super(null, options);

    if (!(bytes instanceof Uint8Array)) {
      throw new InvalidArgument('BufferResponse needs a Buffer or Uint8Array');
    }

    if (!MimeType) {
      throw new InvalidArgument('BufferResponse needs a mime type');
    }

    this.Bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  public async execute(_req: express.Request, _res: express.Response): Promise<ResponseFunction | void> {
    const status = this.options?.StatusCode ?? this._errorCode;

    return (_rq: express.Request, res: express.Response) => {
      res.status(status);

      // cookies need Configuration from DI; skip the lookup when there are none
      if (this.options?.Coockies?.length) {
        _setCoockies(res, this.options);
      }
      _setHeaders(res, this.options);

      // set last so a Content-Type in options.Headers cannot mislabel the payload
      res.set('Content-Type', this.MimeType);
      res.send(this.Bytes);
    };
  }
}
