/* eslint-disable security/detect-non-literal-fs-filename */
import { AsyncService, IInstanceCheck, IMappableService } from '@spinajs/di';
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

export interface IFsLocalOptions {
  /**
   * Full path to local directory where files are hold.
   * All paths will be relative to this directory
   */
  basePath: string;

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
  maxFileAge : number;
}

export interface IZipResult {
  asFilePath(): string;
  asStream(): ReadStream;
  asBase64(): string;
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
  public abstract download(path: string): Promise<string>;
  public abstract resolvePath(path: string): string;
  public abstract read(path: string, encoding: BufferEncoding): Promise<string | Buffer>;
  public abstract readStream(path: string, encoding?: BufferEncoding): Promise<ReadStream>;
  public abstract write(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void>;
  public abstract writeStream(path: string, encoding?: BufferEncoding): Promise<WriteStream | PassThrough>;
  public abstract exists(path: string): Promise<boolean>;
  public abstract dirExists(path: string): Promise<boolean>;
  public abstract copy(path: string, dest: string): Promise<void>;
  public abstract move(oldPath: string, newPath: string): Promise<void>;
  public abstract rename(oldPath: string, newPath: string): Promise<void>;
  public abstract unlink(path: string, downloaded?: boolean): Promise<void>;
  public abstract rm(path: string): Promise<void>;
  public abstract mkdir(path: string): Promise<void>;
  public abstract stat(path: string): Promise<IStat>;
  public abstract list(path: string): Promise<string[]>;
  public abstract tmppath(): string;
  public abstract append(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void>;
  /**
   *
   * Compress specified file or dir in provided path. If
   * Dir is compressed recursively
   *
   * @param path - path to zip
   */
  public abstract zip(path: string): Promise<IZipResult>;

  public tmpname() {
    return uuidv4();
  }
}
