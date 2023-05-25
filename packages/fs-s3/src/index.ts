import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, IStat, IZipResult } from '@spinajs/fs';
import * as AWS from 'aws-sdk';
import { Config } from '@spinajs/configuration';
import archiver from 'archiver';
import { basename } from 'path';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { createReadStream, readFileSync } from 'fs';
import { DateTime } from 'luxon';
import stream from 'stream';

export interface IS3Config {
  bucket: string;
  name: string;
}

/**
 * Abstract layer for file operations.
 * Basic implementation is just wrapper for native node fs functions
 *
 * It allows to wrap other libs eg. aws s3, ftp
 * and inject it into code without changing logic that use them.
 *
 * TODO: map errors to some kind of common errors shared with other implementations
 */
@Injectable('fs')
@PerInstanceCheck()
export class fsS3 extends fs {
  @Logger('fs')
  protected Logger: Log;

  protected S3: AWS.S3;

  @Config('fs.s3.config')
  protected AwsConfig: AWS.ConfigurationOptions;

  @Config('fs.s3.configPath')
  protected ConfigPath: string;

  /**
   * File system for temporary files
   */
  protected TempFs: fs;

  /**
   * Name of provider. We can have multiple providers of the same type but with different options.
   * Also used in InjectService decorator for mapping
   */
  public get Name(): string {
    return this.Options.name;
  }

  constructor(public Options: IS3Config) {
    super();
  }

  public async resolve() {
    AWS.config.update(this.AwsConfig);

    if (this.ConfigPath) {
      AWS.config.loadFromPath(this.ConfigPath);
    } else if (this.AwsConfig) {
      AWS.config.update(this.AwsConfig);
    }

    this.S3 = new AWS.S3();

    this.TempFs = await DI.resolve<Promise<fs>>('__file_provider__', ['fs-temp']);
  }

  /**
   *
   * Tries to download file to local filesystem, then returns local filesystem path.
   * Native implementation simply returns local path and does nothing.
   *
   * @param path - file to download
   */
  public async download(path: string): Promise<string> {
    const tmpName = this.TempFs.tmppath();
    const wStream = await this.TempFs.writeStream(tmpName);

    return new Promise((resolve, reject) => {
      this.S3.getObject({
        Bucket: this.Options.bucket,
        Key: path,
      })
        .on('error', (err) => {
          reject(err);
        })
        .on('httpData', (chunk: unknown) => {
          wStream.write(chunk);
        })
        .on('httpDone', () => {
          wStream.end();

          this.Logger.trace(`Downloaded file from S3 bucket ${this.Options.bucket}, file: ${path}`);
          resolve(tmpName);
        });
    });
  }

  /**
   * read all content of file
   */
  public async read(path: string, encoding: BufferEncoding) {
    const fLocal = await this.download(path);
    const content = await this.TempFs.read(fLocal, encoding);

    await this.TempFs.unlink(fLocal);

    return content;
  }

  public async readStream(path: string, encoding?: BufferEncoding) {
    const fLocal = await this.download(path);
    return this.TempFs.readStream(fLocal, encoding);
  }

  /**
   * Write to file string or buffer
   */
  public async write(path: string, data: string | Buffer, encoding?: BufferEncoding) {
    await this.S3.upload({
      Bucket: this.Options.bucket,
      Key: path,
      Body: data,
      ContentEncoding: encoding,
    }).promise();
  }

  public async append(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void> {
    /**
     * We cannot append to file in s3 directly,
     * we have to download file firs, append locally, then upload again new file
     */
    const fLocal = await this.download(path);

    await this.TempFs.append(fLocal, data, encoding);

    const wStream = await this.writeStream(path, encoding);
    const rStream = await this.TempFs.readStream(fLocal, encoding);

    return new Promise((resolve, reject) => {
      rStream
        .pipe(wStream)
        .on('end', () => {
          this.TempFs.rm(fLocal)
            .then(() => {
              return resolve();
            })
            .catch(() => {
              resolve();
            });
        })
        .on('error', (err) => {
          // eslint-disable-next-line promise/no-promise-in-callback
          this.TempFs.rm(fLocal)
            .then(() => {
              return reject(err);
            })
            .catch(() => {
              reject(err);
            });
        });
    });
  }

  public async writeStream(path: string, encoding?: BufferEncoding) {
    const s = new stream.PassThrough();

    this.S3.upload(
      {
        Bucket: this.Options.bucket,
        Key: path,
        Body: s,
        ContentEncoding: encoding,
      },
      (err) => {
        if (err) {
          this.Logger.error(`Cannot write file ${path} as stream to s3 bucket`);
        }
      },
    );

    return Promise.resolve(s);
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  public async exists(path: string) {
    try {
      await this.S3.headObject({
        Bucket: this.Options.bucket,
        Key: path,
      }).promise();
    } catch (err) {
      if ((err as Error).name === 'ResourceNotFoundException') {
        return false;
      }
    }

    return true;
  }

  public async dirExists() {
    // s3 does not have concept of folders
    // we assume that all exists
    return Promise.resolve(true);
  }

  /**
   * Copy file to another location
   * @param path - src path
   * @param dest - dest path
   */
  public async copy(path: string, dest: string) {
    const copyparams = {
      Bucket: this.Options.bucket,
      CopySource: this.Options.bucket + '/' + path,
      Key: dest,
    };

    await this.S3.copyObject(copyparams).promise();
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: string, newPath: string) {
    await this.copy(oldPath, newPath);
    await this.unlink(oldPath);
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: string, newPath: string) {
    return this.move(oldPath, newPath);
  }

  /**
   * Deletes file permanently
   *
   * @param path - path to file that will be deleted
   * @param onlyTemp - remote filesystems need to download file before, if so, calling unlink with this flag removes only local temp file after we finished processing
   */
  public async unlink(path: string, onlyTemp?: boolean) {
    if (onlyTemp) {
      await this.TempFs.unlink(path);
      return;
    }

    await this.S3.deleteObject({
      Key: path,
      Bucket: this.Options.bucket,
    }).promise();
  }

  /**
   *
   * Deletes dir recursively & all contents inside
   *
   * @param path - dir to remove
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  public async rm(_path: string) {
    // s3 is not deleting folders
  }

  /**
   *
   * Creates directory, recursively
   *
   */
  public async mkdir() {
    // s3 dont need to create folders
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  public async stat(path: string): Promise<IStat> {
    const result = await this.S3.headObject({
      Bucket: this.Options.bucket,
      Key: path,
    }).promise();

    return {
      // no directories in s3
      IsDirectory: false,

      // only files can be stored in s3
      IsFile: true,

      // no creation time
      CreationTime: DateTime.min(),
      ModifiedTime: DateTime.fromJSDate(result.LastModified),

      // no access time in s3
      AccessTime: DateTime.min(),
      Size: result.ContentLength,
    };
  }

  protected async getSignedUrl(path: string) {
    return this.S3.getSignedUrlPromise('getObject', {
      Bucket: this.Options.bucket,
      Key: path,
      Expires: 24 * 60 * 60,
    });
  }

  public tmppath(): string {
    throw new MethodNotImplemented('fs s3 does not support temporary paths');
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  public async list(path: string) {
    const params = {
      Bucket: this.Options.bucket,
      Delimiter: '/',
      Prefix: path,
    };

    // TODO: support more than 1000 items using continuation token
    const result = await this.S3.listObjectsV2(params).promise();
    return result.Contents.map((x) => x.Key);
  }

  public async zip(path: string, zName?: string): Promise<IZipResult> {
    const zTmpName = this.TempFs.tmppath();
    const output = await this.TempFs.writeStream(zTmpName);
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Sets the compression level.
    });

    // pipe archive data to the file
    archive.pipe(output);

    const tFile = await this.download(path);
    archive.file(tFile, { name: zName ?? basename(path) });

    await archive.finalize();

    return {
      asFilePath: () => {
        return zTmpName;
      },
      asStream: (encoding?: BufferEncoding) => {
        return createReadStream(`${zTmpName}`, encoding);
      },
      asBase64: () => {
        return readFileSync(`${zTmpName}`, 'base64');
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public resolvePath() {
    throw new MethodNotImplemented('fs s3 does not support path resolving');
  }
}
