/* eslint-disable security/detect-non-literal-fs-filename */
import { AsyncService, DI, IInstanceCheck, IMappableService } from '@spinajs/di';
import { ReadStream, WriteStream } from 'fs';
import { DateTime } from 'luxon';
import { PassThrough } from 'stream';
import { v4 as uuidv4 } from 'uuid';

export interface IProviderConfiguration {
  name: string;
  service: string;
}
export interface IFsConfiguration {
  defaultProvider: string;
  providers: IProviderConfiguration[];
}

export interface IStat {
  IsDirectory?: boolean;
  IsFile?: boolean;
  Size?: number;
  AccessTime?: DateTime;
  ModifiedTime?: DateTime;
  CreationTime?: DateTime;
  AdditionalData?: unknown;
}

export interface IFileInfo {
  /**
   * Size in bytes
   */

  FileSize: number;
  Height?: number;
  Width?: number;

  Duration?: number;
  FrameCount?: number;
  FrameRate?: number;

  Bitrate?: number;
  Codec?: string;

  LineCount?: number;
  Encoding?: string;
  MimeType?: string;
  WordCount?: number;

  AccessDate?: DateTime;
  ModificationDate?: DateTime;
  CreationDate?: DateTime;

  /**
   * Raw unprocessed data obtained from file info
   */
  Raw?: {};
}

export interface IFsLocalOptions {
  /**
   * Full path to local directory where files are hold.
   * All paths will be relative to this directory
   *
   * If path is not provided, it will behave like normal nodejs fs functions
   */
  basePath?: string;

  /**
   * Instance name of this filesystem. Used to share fs instances.
   */
  name: string;
}

export interface IFsLocalTempOptions extends IFsLocalOptions {
  /**
   * Should cleanup of old temp files be enabled
   */
  cleanup: boolean;

  /**
   * Cleanup interval in seconds
   * Default is 10 minutes
   */
  cleanupInterval: number;

  /**
   * Max temp file age in seconds. Older thant this will be deleted.
   * Default is 1 hour
   */
  maxFileAge: number;
}

export interface IZipResult {
  /**
   * Destination filesystem ( default is fs-temp for zipped files)
   */
  fs: fs;

  // return file path to zipped file
  asFilePath(): string;

  // return as stream to zipped content
  asStream(): ReadStream;

  // return base64 representation of zipped content
  asBase64(): string;

  // deletes zipped  file ( from temp filesystem )
  unlink(): void;
}

export abstract class fs extends AsyncService implements IMappableService, IInstanceCheck {
  public get ServiceName() {
    return this.Name;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public __checkInstance__(creationOptions: any): boolean {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return this.Name === creationOptions[0].name;
  }

  public abstract Name: string;

  /**
   * Downloads file to local storage and returns path to it.
   * If used on local storage provider eg. hard drive it only returns full path to file
   *
   * On remote storage provivers eg. amazon s3 - it tries to download it to local disk first and returns
   * full path.
   *
   * Returns local path to file
   *
   * @param path path to download
   */
  public abstract download(path: string): Promise<string>;

  /**
   * Copies local file into fs
   *
   * @param srcPath source path ( full absolute path eg. file from local disk )
   * @param destPath dest path ( relative to base path of provider )
   */
  public abstract upload(srcPath: string, destPath?: string): Promise<void>;

    /**
   *
   * Returns hash of file
   *
   * @param srcPath file to calculate hash
   * @param algo optional hash alghoritm, default is md5
   */
  public async hash(path: string, algo?: string): Promise<string> {
    const hasher = DI.resolve<FileHasher>(FileHasher, [algo]);
    return hasher.hash(this.resolvePath(path));
  }
 
  /**
   *
   * Returns full LOCAL path to file
   *
   * @param path path to resolve
   */
  public abstract resolvePath(path: string): string;
  public abstract read(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  public abstract readStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream>;
  public abstract write(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  public abstract writeStream(path: string, encoding?: BufferEncoding): Promise<WriteStream | PassThrough>;
  public abstract writeStream(
    path: string,
    readStream: NodeJS.ReadableStream | BufferEncoding,
    encoding?: BufferEncoding,
  ): Promise<WriteStream | PassThrough>;
  public abstract exists(path: string): Promise<boolean>;
  public abstract dirExists(path: string): Promise<boolean>;
  public abstract copy(path: string, dest: string, dstFs?: fs): Promise<void>;
  public abstract move(oldPath: string, newPath: string, dstFs?: fs): Promise<void>;
  public abstract rename(oldPath: string, newPath: string): Promise<void>;
  public abstract rm(path: string): Promise<void>;
  public abstract mkdir(path: string): Promise<void>;
  public abstract stat(path: string): Promise<IStat>;
  public abstract list(path: string): Promise<string[]>;
  public abstract tmppath(): string;
  public abstract append(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  /**
   *
   * Compress specified file or dir in provided path. If
   * Dir is compressed recursively
   *
   * @param path - path to zip
   * @param dstFile - destination file name
   */
  public abstract zip(path: string | string[], dstFs?: fs, dstFile?: string): Promise<IZipResult>;

  /**
   * Decompress given file to destination path
   *
   * @param path path to zip file
   * @param destPath path to destination dir
   * 
   * @returns path to unzipped file
   */
  public abstract unzip(srcPath: string, destPath?: string, dstFs?: fs): Promise<string>;

  /**
   *
   * Checks if given path is dir
   *
   * @param path path to check
   */
  public abstract isDir(path: string): Promise<boolean>;

  public tmpname() {
    return uuidv4();
  }
}

/**
 * File information service, obtain file props, metadata etc.
 * Eg. movie resolution, image, codec etc. if possible
 */
export abstract class FileInfoService {
  public abstract getInfo(pathToFile: string): Promise<IFileInfo>;
}

/**
 * File hasher, to create unique hash for file
 */
export abstract class FileHasher {
  public abstract hash(pathToFile: string): Promise<string>;
}
