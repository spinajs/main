import { Autoinject, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, IStat, IZipResult, FileSystem, FileInfoService } from '@spinajs/fs';
import {
  S3Client,
  S3ClientConfig,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Config } from '@spinajs/configuration';
import path, { basename } from 'path';
import { IOFail, MethodNotImplemented } from '@spinajs/exceptions';
import { createReadStream, existsSync } from 'fs';
import { DateTime } from 'luxon';
import { Readable } from 'stream';
import iconv from 'iconv-lite';

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

  protected S3: S3Client;

  @Config('fs.s3.config')
  protected AwsConfig: S3ClientConfig;

  /**
   * File system for temporary files
   */
  @FileSystem('fs-temp-s3')
  protected TempFs: fs;

  @Autoinject()
  protected FileInfo: FileInfoService;

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
    this.S3 = new S3Client(
      Object.assign({}, this.AwsConfig, {
        endpoint: this.AwsConfig.endpoint ?? undefined,
        logger: {
          trace: (msg: any) => this.Logger.trace(msg),
          debug: (msg: any) => this.Logger.debug(msg),
          info: (msg: any) => this.Logger.info(msg),
          warn: (msg: any) => this.Logger.warn(msg),
          error: (msg: any) => this.Logger.error(msg),
        },
      }),
    );
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

    const command = new GetObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });

    const result = await this.S3.send(command);

    return new Promise((resolve, reject) => {
      if (result.Body instanceof Readable) {
        result.Body.pipe(wStream)
          .on('error', (err) => reject(err))
          .on('close', () => resolve(tmpName));
      } else {
        reject(new IOFail(`Cannot download file ${path}, empty response`));
      }
    });
  }

  /**
   * read all content of file
   */
  public async read(path: string, encoding: BufferEncoding) {
    const fLocal = await this.download(path);
    const content = await this.TempFs.read(fLocal, encoding);

    await this.TempFs.rm(fLocal);

    return content;
  }

  /**
   *
   * @param path
   * @param _encoding
   * @returns
   */
  public async readStream(path: string, encoding?: BufferEncoding) {
    const command = new GetObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });

    const result = await this.S3.send(command);
    const rStream = result.Body as Readable;
    if (encoding) {
      const encodedStream = rStream.pipe(iconv.decodeStream(encoding));
      return encodedStream;
    }

    return rStream;
  }

  /**
   * Write to file string or buffer
   */
  public async write(path: string, data: string | Buffer, encoding?: BufferEncoding) {
    const upload = new Upload({
      client: this.S3,
      params: {
        Bucket: this.Options.bucket,
        Key: path,
        Body: data,
        ContentEncoding: encoding,
      },
    });
    await upload.done();
  }

  /**
   * NOTE: append on s3 downloads file, appends to it, then uploads it again
   * so it can be slow on large files
   *
   * @param path
   * @param data
   * @param encoding
   */
  public async append(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void> {
    /**
     * We cannot append to file in s3 directly,
     * we have to download file first, append locally, then upload again new file
     */
    const fLocal = await this.download(path);

    await this.TempFs.append(fLocal, data, encoding);
    await this.upload(fLocal, path);
  }

  public async upload(srcPath: string, destPath?: string) {
    if (!existsSync(srcPath)) {
      throw new IOFail(`file ${srcPath} does not exists`);
    }

    const dPath = destPath ?? basename(srcPath);
    const rStream = createReadStream(srcPath);
    const hash = await this.hash(srcPath, 'md5');
    const fInfo = await this.FileInfo.getInfo(this.resolvePath(srcPath));

    const upload = new Upload({
      client: this.S3,
      params: {
        Bucket: this.Options.bucket,
        Key: dPath,
        Body: rStream,

        // content md5 header is always base64 encoded
        ContentMD5: Buffer.from(hash, 'hex').toString('base64'),

        // convert all metadata values to string, and back to object with key-value pair of strings
        Metadata: Object.fromEntries(Object.entries(fInfo).map(([key, value]) => [key, String(value)])),
      },
    });

    await upload.done();
  }

  /**
   *
   * Gets metadata of file in s3 bucket
   *
   * @param path path to file
   * @returns
   */
  public async getMetadata(path: string) {
    const command = new HeadObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });

    const result = await this.S3.send(command);

    return result.Metadata;
  }

  /**
   *
   * Returns writable stream for given path
   *
   * @param path file path ( relative to base path of provider)
   * @param rStream readable stream, must be provided beforehand
   * @param encoding optional stream encoding
   */
  public async writeStream(_path: string, _encoding?: BufferEncoding): Promise<any> {
    throw new IOFail('Method not implemented, s3 does not support writable streams');
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  public async exists(path: string) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.Options.bucket,
        Key: path,
      });

      await this.S3.send(command);
    } catch (err) {
      if (err.name === 'NotFound') return false;
      throw err;
    }

    return true;
  }

  public async dirExists(): Promise<boolean> {
    throw new IOFail('Method not implemented, s3 does not support directories');
  }

  /**
   * Copy file to another location
   * @param path - src path
   * @param dest - dest path
   */
  public async copy(path: string, dest: string, dstFs?: fs) {
    // if dest fs is set
    // copy using it
    if (dstFs) {
      const file = await this.download(path);
      await dstFs.upload(file, dest);
    } else {
      // we copy file in s3 by copying it to another location
      const command = new CopyObjectCommand({
        Bucket: this.Options.bucket,
        CopySource: this.Options.bucket + '/' + path,
        Key: dest,
      });

      await this.S3.send(command);
    }
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: string, newPath: string, dstFs?: fs) {
    await this.copy(oldPath, newPath, dstFs);
    await this.rm(oldPath);
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: string, newPath: string) {
    return this.move(oldPath, newPath);
  }

  /**
   *
   * Deletes dir recursively & all contents inside
   *
   * @param path - dir to remove
   */
  public async rm(_path: string) {
    const command = new DeleteObjectCommand({
      Bucket: this.Options.bucket,
      Key: _path,
    });

    await this.S3.send(command);
  }

  /**
   *
   * Creates directory, recursively
   *
   */
  public async mkdir() {
    throw new IOFail('Method not implemented, s3 does not support directories');
  }

  public async isDir(_path: string): Promise<boolean> {
    throw new IOFail('Method not implemented, s3 does not support directories');
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  public async stat(path: string): Promise<IStat> {
    const command = new HeadObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });

    const result = await this.S3.send(command);

    return {
      // no directories in s3
      IsDirectory: false,

      // only files can be stored in s3
      IsFile: true,

      // no creation time
      CreationTime: DateTime.min(),
      ModifiedTime: DateTime.fromJSDate(result.LastModified),

      // no access time in s3s
      AccessTime: DateTime.min(),
      Size: result.ContentLength,
    };
  }

  // protected async getSignedUrl(path: string) {

  //   return this.S3.getSignedUrlPromise('getObject', {
  //     Bucket: this.Options.bucket,
  //     Key: path,
  //     Expires: 24 * 60 * 60,
  //   });
  // }

  public tmppath(): string {
    throw new MethodNotImplemented('fs s3 does not support temporary paths');
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  public async list(path: string) {
    const command = new ListObjectsV2Command({
      Bucket: this.Options.bucket,
      Delimiter: '/',
      Prefix: path,
    });

    const result = await this.S3.send(command);
    return result.Contents.map((x) => x.Key);
  }

  public async unzip(_path: string, _destPath?: string, _dstFs?: fs) : Promise<string> {
    throw new IOFail('Method not implemented, you should download zipped to local fs first, then unzip it');
  }

  public async zip(_path: string, _dstFs?: fs, _dstFile?: string): Promise<IZipResult> {
    throw new IOFail('Method not implemented, you should zip files locally, then upload it');
  }

  public resolvePath(_path: string): string {
    // we checek if path is absolute
    // for hash function
    if (path.isAbsolute(_path)) {
      return _path;
    }

    throw new MethodNotImplemented('fs s3 does not support path resolving');
  }
}
