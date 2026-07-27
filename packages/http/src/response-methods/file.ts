import { DI } from '@spinajs/di';
import { IOFail, ResourceNotFound } from '@spinajs/exceptions';
import * as express from 'express';
import _ from 'lodash';
import { promises } from 'fs';
import { resolve as resolvePath } from 'path';
import { IFileResponseOptions, IResponseOptions, Response } from './../interfaces.js';
import { fs } from '@spinajs/fs';
// import from the defining module, not the package barrel - '../index.js' pulls
// the whole export graph back through interfaces.js and re-forms an import cycle
import { _setCoockies, _setHeaders } from '../responses.js';

export class ZipResponse extends Response {
  /**
   * Sends zipped file to client at given path & filename. If file exists
   * it will send file with 200 OK, if not exists 404 NOT FOUND
   */
  constructor(protected Options: IFileResponseOptions, protected responseOptions?: IResponseOptions) {
    super(null);

    // The payload is always a zip archive — default to application/zip rather
    // than deriving from the (original) download filename, which would mislabel
    // e.g. a zipped `report.txt` as text/plain.
    this.Options.mimeType = Options.mimeType ?? 'application/zip';
    this.Options.provider = Options.provider ?? 'local';
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const provider = await DI.resolve<fs>('__file_provider__', [this.Options.provider]);
    const exists = await provider.exists(this.Options.path);

    if (!exists) {
      throw new ResourceNotFound(`File ${this.Options.path} not exists`);
    }

    const zippedFile = await provider.zip(this.Options.path);
    const fPath = zippedFile.asFilePath();

    return new Promise((resolve, reject) => {
      const encodedFilename = encodeURIComponent(this.Options.filename);

      _setCoockies(res, this.responseOptions);
      _setHeaders(res, this.responseOptions);

      res.setHeader('Content-Type', this.Options.mimeType || 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);

      res.sendFile(zippedFile.fs.resolvePath(fPath), (err: Error) => {
        zippedFile.fs.rm(fPath).finally(() => {
          if (!_.isNil(err)) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }
}

export class FileResponse extends Response {
  /**
   * Sends file to client at given path & filename. If file exists
   * it will send file with 200 OK, if not exists 404 NOT FOUND
   */
  constructor(protected Options: IFileResponseOptions, protected responseOptions?: IResponseOptions) {
    super(null);

    // Do NOT default the mime type here. When the caller doesn't specify one we
    // let res.sendFile derive it from the actual file, which yields the correct
    // charset for text types (e.g. `text/plain; charset=utf-8`) and the right
    // type for binaries — deriving it from the filename dropped the charset.
    this.Options.mimeType = Options.mimeType;
    this.Options.provider = Options.provider ?? 'local';
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const provider = await DI.resolve<fs>('__file_provider__', [this.Options.provider]);
    if (!provider) {
      throw new IOFail(`Provider ${this.Options.provider} not registered in configuration. Use default or check configuration.`);
    }

    const exists = await provider.exists(this.Options.path);

    if (!exists) {
      throw new ResourceNotFound(`File ${this.Options.path} not exists`);
    }

    const file = await provider.download(this.Options.path);

    // A local provider returns the real on-disk file (must NOT be deleted); a
    // remote provider downloads to a throwaway temp copy that must be cleaned
    // up after sending. Detect the local case by the file living under the
    // provider's own base path.
    const basePath = (provider as any).Options?.basePath as string | undefined;
    const isLocalRealFile = !!basePath && resolvePath(file).startsWith(resolvePath(basePath));

    return new Promise((resolve, reject) => {

      const encodedFilename = encodeURIComponent(this.Options.filename);

      _setCoockies(res, this.responseOptions);
      _setHeaders(res, this.responseOptions);

      // Only pin the Content-Type when the caller gave an explicit mime type;
      // otherwise let sendFile set it from the file (correct charset / type).
      if (this.Options.mimeType) {
        res.setHeader('Content-Type', this.Options.mimeType);
      }
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);

      res.sendFile(file, (err: Error) => {
        const cleanups: Promise<unknown>[] = [];

        // Remove the source file on the provider when requested.
        if (this.Options.deleteAfterDownload) {
          cleanups.push(provider.rm(this.Options.path).catch(() => undefined));
        }

        // Remove the downloaded temp copy for remote providers (never the real
        // local file).
        if (!isLocalRealFile) {
          cleanups.push(promises.unlink(file).catch(() => undefined));
        }

        Promise.allSettled(cleanups).finally(() => {
          if (!_.isNil(err)) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }
}

export class JsonFileResponse extends Response {
  constructor(protected data: any, protected filename: string, protected responseOptions?: IResponseOptions) {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const provider = await DI.resolve<fs>('__file_provider__', ['fs-temp']);
    const tmpPath = provider.tmppath();
    // Must await: sendFile below races the write otherwise and can hit the
    // path before it exists, producing an intermittent ENOENT / 500.
    await provider.write(tmpPath, JSON.stringify(this.data));

    return new Promise((resolve, reject) => {
      const encodedFilename = encodeURIComponent(this.filename);

      _setCoockies(res, this.responseOptions);
      _setHeaders(res, this.responseOptions);

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);

      res.sendFile(tmpPath, (err: Error) => {
        provider.rm(tmpPath).finally(() => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }
}
