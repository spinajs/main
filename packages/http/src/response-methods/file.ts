import { DI } from '@spinajs/di';
import { IOFail, ResourceNotFound } from '@spinajs/exceptions';
import * as express from 'express';
import _ from 'lodash';
import mime from 'mime';
import { IFileResponseOptions, Response } from './../interfaces.js';
import { fs } from '@spinajs/fs';

export class ZipResponse extends Response {
  /**
   * Sends zipped to client at given path & filename. If file exists
   * it will send file with 200 OK, if not exists 404 NOT FOUND
   */
  constructor(protected Options: IFileResponseOptions) {
    super(null);

    this.Options.mimeType = Options.mimeType ?? mime.getType(Options.filename);
    this.Options.provider = Options.provider ?? 'local';
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const provider = await DI.resolve<fs>('__file_provider__', [this.Options.provider]);
    const exists = await provider.exists(this.Options.path);

    if (!exists) {
      throw new ResourceNotFound(`File ${this.Options.path} not exists`);
    }

    const file = (await provider.zip(this.Options.path)).asFilePath();

    return new Promise((resolve, reject) => {
      res.download(file, this.Options.filename, (err: Error) => {
        provider
          .unlink(this.Options.path, true)
          .then(() => {
            return provider.unlink(file);
          })
          .then(() => {
            if (!_.isNil(err)) {
              reject(err);
            } else {
              resolve();
            }
          })
          .catch((err) => {
            reject(err);
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
  constructor(protected Options: IFileResponseOptions) {
    super(null);

    this.Options.mimeType = Options.mimeType ?? mime.getType(Options.filename);
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

    return new Promise((resolve, reject) => {
      res.download(file, this.Options.filename, (err: Error) => {
        if (this.Options.deleteAfterDownload) {
          provider
            .unlink(this.Options.path, true)
            .then(() => {
              if (!_.isNil(err)) {
                reject(err);
              } else {
                resolve();
              }
            })
            .catch((err) => {
              reject(err);
            });
        } else {
          if (!_.isNil(err)) {
            reject(err);
          } else {
            resolve();
          }
        }
      });
    });
  }
}

export class JsonFileResponse extends Response {
  constructor(protected data: any, protected filename: string) {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const provider = await DI.resolve<fs>('__file_provider__', ['fs-temp']);
    const tmpPath = provider.tmppath();
    provider.write(tmpPath, JSON.stringify(this.data));

    return new Promise((resolve, reject) => {
      res.download(tmpPath, this.filename, (err: Error) => {
        provider
          .unlink(tmpPath)
          .then(() => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          })
          .catch((err) => {
            reject(err);
          });
      });
    });
  }
}
