import { DI } from '@spinajs/di';
import { IOFail, ResourceNotFound } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import * as express from 'express';
import _ from 'lodash';
import { promises } from 'fs';
import type { OutgoingHttpHeaders } from 'http';
import { basename, resolve as resolvePath } from 'path';
import { IFileResponseOptions, IResponseOptions, Response } from './../interfaces.js';
import { getFs } from '@spinajs/fs';
// import from the defining module, not the package barrel - '../index.js' pulls
// the whole export graph back through interfaces.js and re-forms an import cycle
import { sendFileAt } from './send-file.js';
import { _setCoockies, _setHeaders } from '../responses.js';
import { strictHeader } from '../headers.js';

export class ZipResponse extends Response {
  /**
   * Sends zipped file to client at given path & filename. If file exists
   * it will send file with 200 OK, if not exists 404 NOT FOUND.
   * Always an attachment: `disposition` and `headers` are `FileResponse` only.
   */
  constructor(protected Options: Omit<IFileResponseOptions, 'disposition' | 'headers'>, protected responseOptions?: IResponseOptions) {
    super(null);

    // The payload is always a zip archive — default to application/zip rather
    // than deriving from the (original) download filename, which would mislabel
    // e.g. a zipped `report.txt` as text/plain.
    this.Options.mimeType = Options.mimeType ?? 'application/zip';
    this.Options.provider = Options.provider ?? 'local';
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const provider = await getFs(this.Options.provider!);
    const exists = await provider.exists(this.Options.path);

    if (!exists) {
      throw new ResourceNotFound(`File ${this.Options.path} not exists`);
    }

    const zippedFile = await provider.zip(this.Options.path);
    const fPath = zippedFile.asFilePath();

    return new Promise((resolve, reject) => {
      const encodedFilename = encodeURIComponent(this.Options.filename ?? `${basename(this.Options.path)}.zip`);

      _setCoockies(res, this.responseOptions);
      _setHeaders(res, this.responseOptions);

      res.setHeader('Content-Type', this.Options.mimeType || 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);

      sendFileAt(res, zippedFile.fs.resolvePath(fPath), (err) => {
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

/** What `send` reports on a failure: an http-errors status, or a Node error code. */
type SendFailure = Error & { status?: number; code?: string };

// Only these exact forms are rewritten; anything else goes to send as the client sent it, so range-parser alone judges it.
const SUFFIX_RANGE = /^bytes=-(\d{1,15})$/;
const SUFFIX_RANGE_MAX_LENGTH = 64;

export class FileResponse extends Response {
  /**
   * Sends file to client at given path & filename. If file exists
   * it will send file with 200 OK, if not exists 404 NOT FOUND.
   * Single byte ranges, `ETag` / `Last-Modified` validators, 304, 412, 416 and HEAD come from Express' `res.sendFile`.
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

  public async execute(req: express.Request, res: express.Response): Promise<void> {
    const provider = await getFs(this.Options.provider!);
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

    // wholeFileForLongSuffix rewrites the header for send; later middleware and logs must still see the client's.
    const clientRange = req.headers.range;
    await this.wholeFileForLongSuffix(req, file);

    return new Promise((resolve, reject) => {
      _setCoockies(res, this.responseOptions);
      _setHeaders(res, this.responseOptions);

      const headersBeforeFile = res.getHeaders();

      sendFileAt(res, file, (err) => {
        if (clientRange === undefined) {
          delete req.headers.range;
        } else {
          req.headers.range = clientRange;
        }

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
          const unanswered = _.isNil(err) ? null : this.answerSendFailure(res, err, headersBeforeFile);
          if (unanswered) {
            reject(unanswered);
          } else {
            resolve();
          }
        });
      }, { headers: this.fileHeaders() });
    });
  }

  protected fileHeaders(): Record<string, unknown> {
    const disposition = this.Options.disposition ?? 'attachment';
    const filename = this.Options.filename ?? (disposition === 'attachment' ? basename(this.Options.path) : undefined);

    return {
      ...(disposition === 'inline' ? { 'X-Content-Type-Options': 'nosniff' } : {}),
      ...this.Options.headers,
      // Without an explicit mime type send derives it from the extension, with the charset of a text type.
      ...(this.Options.mimeType ? { 'Content-Type': this.Options.mimeType } : {}),
      'Content-Disposition': filename === undefined ? disposition : `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    };
  }

  /**
   * range-parser refuses `bytes=-N` with N past the size (416); RFC 9110 §14.1.2 sends the whole file for it.
   * `bytes=-` names no range at all, so it gets the whole file too.
   */
  private async wholeFileForLongSuffix(req: express.Request, file: string): Promise<void> {
    const range = strictHeader(req, 'range', { maxLength: SUFFIX_RANGE_MAX_LENGTH });
    if (range === 'bytes=-') {
      delete req.headers.range;
      return;
    }

    const suffix = range === undefined ? null : SUFFIX_RANGE.exec(range);
    if (!suffix) {
      return;
    }

    const size = (await promises.stat(file).catch(() => null))?.size;
    if (size !== undefined && Number(suffix[1]) >= size) {
      req.headers.range = 'bytes=0-';
    }
  }

  /**
   * Answers what `send` leaves to its caller (Express' sendFile listens for its errors, so send answers none itself),
   * or returns the error for the error handler. While nothing is sent yet, it first puts the headers back as they were
   * before the file: a file header that replaced a middleware's value gets that value back.
   */
  private answerSendFailure(res: express.Response, err: SendFailure, headersBeforeFile: OutgoingHttpHeaders): Error | null {
    if (err.code === 'ECONNABORTED') {
      return null;
    }

    if (res.headersSent) {
      DI.resolve(Log, ['http']).warn({ error: err, path: this.Options.path }, 'File ${path} failed after its headers were sent');
      res.destroy();
      return null;
    }

    for (const name of new Set([...res.getHeaderNames(), ...Object.keys(headersBeforeFile)])) {
      if (err.status === 416 && name === 'content-range') {
        continue;
      }

      const before = headersBeforeFile[name];
      if (before === undefined) {
        res.removeHeader(name);
      } else if (!_.isEqual(res.getHeader(name), before)) {
        res.setHeader(name, before);
      }
    }

    if (err.status === 412 || err.status === 416) {
      res.status(err.status).end();
      return null;
    }

    if (err.status === 404 || err.code === 'EISDIR') {
      return new ResourceNotFound(`File ${this.Options.path} not exists`);
    }

    // send's own errors carry the fs error's fields (path, syscall, errno), which the error map would put in the body.
    return new IOFail(`File ${this.Options.path} cannot be sent`, err);
  }
}

export class JsonFileResponse extends Response {
  constructor(protected data: any, protected filename: string, protected responseOptions?: IResponseOptions) {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const provider = await getFs('fs-temp');
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

      sendFileAt(res, tmpPath, (err) => {
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
