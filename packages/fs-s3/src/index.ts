import { Autoinject, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, IStat, IZipResult, FileSystem, FileInfoService, IFileInfo, IFsUploadOptions } from '@spinajs/fs';
import {
  S3Client,
  S3ClientConfig,
  S3ServiceException,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  BucketLocationConstraint,
} from '@aws-sdk/client-s3';

import { Upload } from '@aws-sdk/lib-storage';
import { Config } from '@spinajs/configuration';
import path, { extname } from 'path';
import { InvalidArgument, InvalidOperation, IOFail, MethodNotImplemented, ResourceDuplicated } from '@spinajs/exceptions';
import { createReadStream, existsSync } from 'fs';
import crypto from 'crypto';
import { DateTime } from 'luxon';
import { PassThrough, Readable } from 'stream';
import iconv from 'iconv-lite';
import { S3UrlSigner, IS3Config } from './interfaces.js';

export * from './interfaces.js';
export * from './s3BucketSigner.js';
export * from './cloudFrontSigner.js';


const toNumber = (v: string) => Number(v);
const toText = (v: string) => v;
const toDate = (v: string) => DateTime.fromISO(v);

/**
 * IFileInfo fields upload() stores as s3 metadata
 */
const FILE_INFO_FIELDS: [string, (v: string) => unknown][] = [
  ['FileSize', toNumber],
  ['MimeType', toText],
  ['Encoding', toText],
  ['Width', toNumber],
  ['Height', toNumber],
  ['Duration', toNumber],
  ['FrameCount', toNumber],
  ['FrameRate', toNumber],
  ['AudioChannels', toNumber],
  ['Bitrate', toNumber],
  ['Codec', toText],
  ['WordCount', toNumber],
  ['LineCount', toNumber],
  ['AccessDate', toDate],
  ['CreationDate', toDate],
  ['ModificationDate', toDate],
];

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

  protected Signer?: S3UrlSigner;

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

  /**
   * Ensures the S3 bucket exists, creating it if necessary based on configuration
   * @private
   */
  private async ensureBucketExists(): Promise<void> {
    try {
      this.Logger.trace({ bucket: this.Options.bucket }, 'Checking if bucket ${bucket} exists');
      await this.S3.send(new HeadBucketCommand({ Bucket: this.Options.bucket }));
      this.Logger.info({ bucket: this.Options.bucket }, 'Bucket ${bucket} exists and is accessible');
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        if (this.Options.createBucketIfNotExists === false) {
          this.Logger.error({ bucket: this.Options.bucket }, 'Bucket ${bucket} does not exist and createBucketIfNotExists is disabled');
          throw new IOFail(`Bucket '${this.Options.bucket}' does not exist`);
        }

        this.Logger.warn({ bucket: this.Options.bucket }, 'Bucket ${bucket} does not exist, attempting to create it');
        try {
          // AWS rejects a CreateBucket without LocationConstraint outside us-east-1
          const region = await this.S3.config.region();
          await this.S3.send(
            new CreateBucketCommand({
              Bucket: this.Options.bucket,
              CreateBucketConfiguration: region && region !== 'us-east-1' ? { LocationConstraint: region as BucketLocationConstraint } : undefined,
            }),
          );
          this.Logger.info({ bucket: this.Options.bucket }, 'Successfully created bucket ${bucket}');
        } catch (createError) {
          this.Logger.error({ error: createError, bucket: this.Options.bucket }, 'Failed to create bucket ${bucket}');
          throw createError;
        }
      } else {
        this.Logger.error(
          { error, bucket: this.Options.bucket, errorName: error.name, statusCode: error.$metadata?.httpStatusCode },
          'Error checking bucket ${bucket}: ${errorName}, code: ${statusCode}',
        );
        throw error;
      }
    }
  }

  public async resolve() {

    await super.resolve();

    this.Logger.info(
      { provider: this.Options.name, bucket: this.Options.bucket },
      'Initializing S3 file provider ${provider} for bucket ${bucket}',
    );
    
    const credentials = typeof this.AwsConfig.credentials === 'function' ? undefined : this.AwsConfig.credentials;
    this.Logger.debug(
      {
        config: {
          endpoint: this.AwsConfig.endpoint,
          region: this.AwsConfig.region,
          secretAccessKey: credentials?.secretAccessKey ? '****' : undefined,
          accessKeyId: credentials?.accessKeyId ? '****' : undefined,
        },
      },
      'S3 Configuration: ${config}',
    );

    this.S3 = new S3Client(
      Object.assign({}, this.AwsConfig, {
        logger: {
          trace: (msg: any) => this.Logger.trace(msg),
          debug: (msg: any) => this.Logger.debug(msg),
          info: (msg: any) => this.Logger.info(msg),
          warn: (msg: any) => this.Logger.warn(msg),
          error: (msg: any) => this.Logger.error(msg),
        },
      }),
    );

    // Check if bucket exists, create if it doesn't
    await this.ensureBucketExists();

    if (this.Options.signer) {
      this.Logger.info({ service: this.Options.signer.service }, 'Initializing URL signer for service ${service}');
      this.Signer = await DI.resolve(this.Options.signer.service, [{...this.Options.signer, bucket: this.Options.bucket, s3Client: this.S3 }]);
      this.Logger.trace(`URL signer initialized successfully`);
    }

    this.Logger.info({ provider: this.Options.name }, 'S3 file provider ${provider} initialized successfully');
  }

  /**
   * Cleanup method to properly close S3 client connections
   * This ensures the event loop can exit and the process can terminate
   */
  public async dispose(): Promise<void> {
    this.Logger.trace({ provider: this.Options.name }, 'Disposing S3 provider ${provider}');

    // fs-temp-s3 is a separately registered provider shared by every fsS3 - do not dispose it here

    if (this.S3) {
      this.Logger.trace({ provider: this.Options.name }, 'Destroying S3 client for provider ${provider}');
      this.S3.destroy();
      this.Logger.info({ provider: this.Options.name }, 'S3 client destroyed for provider ${provider}');
    }

    this.Logger.info({ provider: this.Options.name }, 'S3 provider ${provider} disposed successfully');
  }

  /**
   *
   * Tries to download file to local filesystem, then returns local filesystem path.
   * Native implementation simply returns local path and does nothing.
   *
   * @param path - file to download
   */
  protected async doDownload(path: string): Promise<string> {
    const tmpName = this.TempFs.tmppath(extname(path));
    const wStream = await this.TempFs.writeStream(tmpName);

    const command = new GetObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });

    const result = await this.S3.send(command);

    return new Promise((resolve, reject) => {
      if (result.Body instanceof Readable) {
        result.Body.pipe(wStream)
          .on('error', (err: Error) => reject(err))
          .on('close', () => resolve(tmpName));
      } else {
        reject(new IOFail(`Cannot download file ${path}, empty response`));
      }
    });
  }

  /**
   * read all content of file
   */
  protected async doRead(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
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
  protected async doReadStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
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
  protected async doWrite(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    // store the same hash metadata as upload() does - otherwise hash() throws
    // for files created via write()
    const shaHash = crypto.createHash('sha256');
    const md5Hash = crypto.createHash('md5');

    if (typeof data === 'string') {
      shaHash.update(data, encoding ?? 'utf8');
      md5Hash.update(data, encoding ?? 'utf8');
    } else {
      shaHash.update(data);
      md5Hash.update(data);
    }

    const upload = new Upload({
      client: this.S3,
      params: {
        Bucket: this.Options.bucket,
        Key: path,
        // the SDK would send a string as utf8 regardless of `encoding`, so the stored bytes would not match the hashes
        Body: typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : data,
        Metadata: {
          hash: shaHash.digest('hex'),
          md5: md5Hash.digest('hex'),
        },
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
  protected async doAppend(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    /**
     * We cannot append to file in s3 directly,
     * we have to download file first, append locally, then upload again new file
     */
    const fLocal = await this.download(path);

    try {
      await this.TempFs.append(fLocal, data, encoding);
      await this.upload(fLocal, path);
    } finally {
      await this.TempFs.rm(fLocal);
    }
  }

  protected async doMetadata(path: string): Promise<IFileInfo> {
    const command = new HeadObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });
    const result = await this.S3.send(command);
    const info: Record<string, unknown> = { ...result.Metadata };

    // s3 returns metadata keys lowercased and values as strings - restore the IFileInfo fields upload() stores
    for (const [key, parse] of FILE_INFO_FIELDS) {
      const raw = info[key.toLowerCase()];
      delete info[key.toLowerCase()];
      if (typeof raw === 'string') {
        info[key] = parse(raw);
      }
    }

    return info as IFileInfo;
  }

  /**
   *
   * Returns the SHA-256 hash of file, read from the object's `hash` metadata entry
   *
   * @param srcPath file to calculate hash
   * @param algo not supported, throws when given
   */
  protected async doHash(path: string, algo?: string): Promise<string> {
    if (algo) {
      throw new InvalidArgument(`Hash alghoritm is not supported in s3 filesystem`);
    }

    const command = new HeadObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });

    const result = await this.S3.send(command);
    if(!result.Metadata || !result.Metadata['hash']){
      throw new IOFail(`Hash metadata is not available for file ${path}`);
    }

    return result.Metadata['hash'];
  }

  protected async doUpload(srcPath: string, destPath: string, options?: IFsUploadOptions): Promise<void> {
    if (!existsSync(srcPath)) {
      throw new IOFail(`file ${srcPath} does not exists`);
    }

    // srcPath is a local file; the public hash() would read it as a key of this bucket.
    const hash = await super.doHash(srcPath, 'md5');
    const shaHash = await super.doHash(srcPath, 'sha256');

    let fInfo: Partial<IFileInfo> = {};

    try {
      fInfo = await this.FileInfo.getInfo(this.resolvePath(srcPath));
      // delete raw information from exif
      delete fInfo.Raw;
    } catch (err) {
      this.Logger.warn({ error: err, srcPath }, 'Could not extract file info for ${srcPath}');
    }

    // Create stream after file info extraction to ensure it hasn't been consumed
    const rStream = createReadStream(srcPath);

    const upload = new Upload({
      client: this.S3,
      params: {
        Bucket: this.Options.bucket,
        Key: destPath,
        IfNoneMatch: options?.exclusive ? '*' : undefined,
        Body: rStream,
        ContentType: fInfo.MimeType,

        // IFileInfo now carries every raw exiftool tag; storing all of them would
        // exceed s3's 2KB user-metadata limit, so persist only a bounded, stable
        // subset ( plus the content hashes ). Undefined fields are skipped.
        Metadata: Object.fromEntries(
          Object.entries({
            FileSize: fInfo.FileSize,
            MimeType: fInfo.MimeType,
            Encoding: fInfo.Encoding,
            Width: fInfo.Width,
            Height: fInfo.Height,
            Duration: fInfo.Duration,
            FrameCount: fInfo.FrameCount,
            FrameRate: fInfo.FrameRate,
            AudioChannels: fInfo.AudioChannels,
            Bitrate: fInfo.Bitrate,
            Codec: fInfo.Codec,
            WordCount: fInfo.WordCount,
            LineCount: fInfo.LineCount,
            AccessDate: fInfo.AccessDate,
            CreationDate: fInfo.CreationDate,
            ModificationDate: fInfo.ModificationDate,
            hash: shaHash,
            md5: hash,
          })
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, String(value)]),
        ),
      },
    });

    try {
      await upload.done();
    } catch (err) {
      // 412: the key exists; 409: a concurrent write to the key got there first. Either way the key is not ours to clean up
      if (options?.exclusive && err instanceof S3ServiceException && [409, 412].includes(err.$metadata?.httpStatusCode ?? 0)) {
        throw new ResourceDuplicated(`Cannot upload ${srcPath}, ${destPath} already exists`, err);
      }
      throw err;
    }
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
   * Replaces the user metadata of an object ( x-amz-meta-* ) with `metadata`, keeping its content and content headers.
   * S3 cannot edit metadata in place: the object is copied onto itself, so this is limited to objects of up to 5 GB.
   */
  public async setMetadata(path: string, metadata: Record<string, string>): Promise<void> {
    const head = await this.S3.send(new HeadObjectCommand({ Bucket: this.Options.bucket, Key: path }));

    await this.S3.send(
      new CopyObjectCommand({
        Bucket: this.Options.bucket,
        Key: path,
        CopySource: this.copySource(path),
        MetadataDirective: 'REPLACE',
        Metadata: metadata,
        // REPLACE drops every header not given again
        ContentType: head.ContentType,
        ContentEncoding: head.ContentEncoding,
        ContentDisposition: head.ContentDisposition,
        ContentLanguage: head.ContentLanguage,
        CacheControl: head.CacheControl,
        Expires: head.Expires,
      }),
    );
  }

  /**
   *
   * Returns writable stream for given path. Data written to the returned stream
   * is uploaded to s3 via multipart streaming upload ( @aws-sdk/lib-storage ).
   *
   * NOTE: the upload finishes shortly AFTER the stream is ended - the 'close' event
   * on the returned stream is emitted when the s3 upload has completed.
   *
   * @param path file path ( s3 object key )
   * @param rStream optional readable stream that will be piped into the upload
   * @param encoding optional stream encoding
   */
  protected async doWriteStream(path: string, rStream?: NodeJS.ReadableStream | BufferEncoding, encoding?: BufferEncoding): Promise<PassThrough> {
    const enc = typeof rStream === 'string' ? rStream : encoding;

    // do not auto-emit close on end - we emit it manually when the s3 upload
    // is fully finalized, so callers waiting for 'close' see completed uploads
    const pass = new PassThrough({ emitClose: false, defaultEncoding: enc });

    const upload = new Upload({
      client: this.S3,
      params: {
        Bucket: this.Options.bucket,
        Key: path,
        Body: pass,
      },
    });

    upload
      .done()
      .then(() => {
        this.Logger.trace({ path, bucket: this.Options.bucket }, 'Stream upload to ${path} finished, bucket: ${bucket}');
        pass.emit('close');
      })
      .catch((err) => {
        pass.destroy(new IOFail(`Cannot write stream to ${path}, bucket ${this.Options.bucket}`, err));
      });

    if (rStream && typeof rStream !== 'string' && typeof rStream.pipe === 'function') {
      rStream.pipe(pass);
    }

    return pass;
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  protected async doExists(path: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.Options.bucket,
        Key: path,
      });

      await this.S3.send(command);
    } catch (err) {

      if(err instanceof Error && err.name === 'NotFound') {
        return false;
      }

      throw err;
    }

    return true;
  }

  protected async doDirExists(_path: string): Promise<boolean> {
    // always true, s3 does not have concept od directories
    return Promise.resolve(true);
  }

  /**
   * Copy file to another location
   * @param path - src path
   * @param dest - dest path
   */
  protected async doCopy(path: string, dest: string, dstFs?: fs): Promise<void> {
    // if dest fs is set
    // copy using it
    if (dstFs) {
      const file = await this.download(path);
      try {
        await dstFs.upload(file, dest);
      } finally {
        await this.TempFs.rm(file);
      }
    } else {
      // we copy file in s3 by copying it to another location
      const command = new CopyObjectCommand({
        Bucket: this.Options.bucket,
        CopySource: this.copySource(path),
        Key: dest,
      });

      await this.S3.send(command);
    }
  }

  /**
   * Copy file to another location and deletes src file
   */
  protected async doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    await this.copy(oldPath, newPath, dstFs);
    await this.rm(oldPath);
  }

  /**
   * Change name of a file
   */
  protected async doRename(oldPath: string, newPath: string): Promise<void> {
    await this.move(oldPath, newPath);
  }

  /**
   *
   * Deletes dir recursively & all contents inside
   *
   * @param path - dir to remove
   */
  protected async doRm(path: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.Options.bucket,
      Key: path,
    });

    await this.S3.send(command);
  }

  /**
   *
   * Creates directory, recursively
   *
   */
  protected async doMkdir(_path: string): Promise<void> {
    // some users makes dir if not exists in fs
    // as s3 does not make use of directories always return true
    return Promise.resolve();
  }

  protected async doIsDir(_path: string): Promise<boolean> {
    // some users makes dir if not exists in fs
    // as s3 does not make use of directories always return false for simplicity
    return Promise.resolve(false);
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  protected async doStat(path: string): Promise<IStat> {
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

      // no creation or access time in s3
      CreationTime: undefined,
      ModifiedTime: result.LastModified ? DateTime.fromJSDate(result.LastModified) : undefined,
      AccessTime: undefined,
      Size: result.ContentLength,

      // ETag is an opaque change token. Note: for multipart uploads it is NOT the
      // content MD5 (it carries a -N suffix) — only ever compare it for equality.
      Version: result.ETag,
    };
  }

  protected async doSignedUrl(path: string, opts: { until?: DateTime; disposition?: string }): Promise<string> {
    if (!this.Signer) {
      throw new InvalidOperation(`Cannot sign url for this S3, no signer service configured`);
    }

    const exists = await this.exists(path);
    if (!exists) {
      throw new IOFail(`File ${path} does not exists in bucket ${this.Options.bucket}, fs: ${this.Options.name}`);
    }

    // Neither signer supports a content disposition yet, so opts.disposition is not applied.
    return this.Signer.sign(path, opts.until);
  }

  public tmppath(): string {
    throw new MethodNotImplemented('fs s3 does not support temporary paths');
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  protected async doList(path: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const result = await this.S3.send(
        new ListObjectsV2Command({
          Bucket: this.Options.bucket,
          Delimiter: '/',
          // normalised paths have no trailing '/'; without it the prefix 'dir' lists the common prefix 'dir/', not its objects
          Prefix: path ? `${path}/` : '',
          ContinuationToken: token,
        }),
      );

      keys.push(...((result.Contents?.map((x) => x.Key) ?? []) as string[]));
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);

    return keys;
  }

  /**
   * Downloads the zip to the local temp fs and extracts it there.
   * Destination fs must be a local-path filesystem ( defaults to the temp fs ) -
   * extracting directly onto s3 is not supported.
   */
  protected async doUnzip(srcPath: string, destPath: string, dstFs: fs): Promise<string> {
    const local = await this.download(srcPath);

    try {
      return await this.TempFs.unzip(local, destPath, dstFs);
    } finally {
      try {
        await this.TempFs.rm(local);
      } catch {
        /* best effort cleanup */
      }
    }
  }

  /**
   * Downloads given s3 objects to the local temp fs and zips them there.
   * Result is created on dstFs ( defaults to the temp fs ). Entry names are the
   * object keys.
   */
  protected async doZip(sources: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult> {
    const paths = Array.isArray(sources) ? sources : [sources];
    const downloaded: [string, string][] = [];

    try {
      for (const p of paths) {
        const remote = Array.isArray(p) ? p[0] : p;
        const entryName = Array.isArray(p) ? p[1] : p;
        const local = await this.download(remote);
        downloaded.push([local, entryName]);
      }

      return await this.TempFs.zip(downloaded, dstFs, dstFile);
    } finally {
      for (const [local] of downloaded) {
        try {
          await this.TempFs.rm(local);
        } catch {
          /* best effort cleanup */
        }
      }
    }
  }

  protected zipDestination(): fs {
    return this.TempFs;
  }

  protected unzipDestination(): fs {
    return this.TempFs;
  }

  /**
   * CopySource must be URL-encoded; the bucket name and the `/` separators stay as they are
   */
  protected copySource(path: string): string {
    return `${this.Options.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
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
