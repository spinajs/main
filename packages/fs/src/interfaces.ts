/* eslint-disable security/detect-non-literal-fs-filename */
import { AsyncService } from '@spinajs/di';
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

export interface IZipResult {
  asFilePath(): string;
  asStream(): ReadStream;
  asBase64(): string;
}

export abstract class fs extends AsyncService {
  public abstract Name: string;
  public abstract download(path: string): Promise<string>;
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
