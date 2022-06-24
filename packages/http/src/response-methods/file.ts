import { ResourceNotFound } from '@spinajs/exceptions';
import * as express from 'express';
import * as fs from 'fs';
import * as _ from 'lodash';
import { getType } from 'mime';
import { Response } from '../responses';
import { format, Row, FormatterOptionsArgs } from '@fast-csv/format';
import tempfile from 'tempfile';

export class FileResponse extends Response {
  protected path: string;
  protected filename: string;
  protected mimeType: string;

  /**
   * Sends file to client at given path & filename. If file exists
   * it will send file with 200 OK, if not exists 404 NOT FOUND
   * @param path - server full path to file
   * @param filename - real filename send to client
   * @param mimeType - optional mimetype. If not set, server will try to guess.
   */
  constructor(path: string, filename: string, mimeType?: string) {
    super(null);

    this.mimeType = mimeType ? mimeType : getType(filename);
    this.filename = filename;
    this.path = path;

    if (!fs.existsSync(path)) {
      throw new ResourceNotFound(`File ${path} not exists`);
    }
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    return new Promise((resolve, reject) => {
      res.download(
        this.path,
        this.filename,
        (err: Error) => {
          if (!_.isNil(err)) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  }
}

export class CvsFileResponse<I extends Row, O extends Row> extends Response {

  constructor(protected data: any, protected filename: string, protected options?: FormatterOptionsArgs<I, O> | undefined) {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {

    const csvStream = format(this.options);

    const tempPath = tempfile('.cvs');
    const file = await fs.promises.open(tempPath, "w");

    return new Promise((resolve, reject) => {
      csvStream.pipe(file.createWriteStream())
        .on("end", () => {

          file.close().then(() => {
            res.download(
              tempPath,
              this.filename,
              (err: Error) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }

                fs.unlink(tempPath, null);
              },
            );
          })
        })
    });
  }
}

export class JsonFileResponse extends Response {
  constructor(protected data: any, protected filename: string) {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {

    const tempPath = tempfile('.json');
    const file = await fs.promises.open(tempPath, "w");

    await file.writeFile(JSON.stringify(this.data));

    return new Promise((resolve, reject) => {
      res.download(
        tempPath,
        this.filename,
        (err: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }

          fs.unlink(tempPath, null);
        },
      );
    });
  }
}
