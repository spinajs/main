/* eslint-disable security/detect-non-literal-fs-filename */
import { IOFail } from './../../exceptions/src/index';
import { PathLike, constants, ReadStream, WriteStream } from 'fs';
import { unlink, rm, stat, readdir, rename, mkdir, copyFile, access, open } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';

export interface IStat {
  IsDirectory?: boolean;
  IsFile?: boolean;
  Size?: number;
  AccessTime?: DateTime;
  ModifiedTime?: DateTime;
  CreationTime?: DateTime;
}

export abstract class fs {
  public abstract get Provider(): string;
  public abstract download(path: PathLike): Promise<string>;
  public abstract read(path: string, encoding: BufferEncoding): Promise<string>;
  public abstract readStream(path: string): Promise<ReadStream>;
  public abstract write(path: string, data: string | Buffer, encoding: BufferEncoding): Promise<void>;
  public abstract writeStream(path: string): Promise<WriteStream>;
  public abstract exists(path: PathLike): Promise<boolean>;
  public abstract dirExists(path: PathLike): Promise<boolean>;
  public abstract copy(path: string, dest: string): Promise<void>;
  public abstract move(oldPath: PathLike, newPath: PathLike): Promise<void>;
  public abstract rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
  public abstract unlink(path: PathLike): Promise<void>;
  public abstract rm(path: PathLike): Promise<void>;
  public abstract mkdir(path: PathLike): Promise<void>;
  public abstract stat(path: PathLike): Promise<IStat>;
  public abstract list(path: PathLike): Promise<string[]>;
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
export class fsNative extends fs {
  public get Provider() {
    return 'fs-native';
  }

  /**
   *
   * Tries to download file to local filesystem, then returns local filesystem path.
   * Native implementation simply returns local path and does nothing.
   *
   * @param path - file to download
   */
  public async download(path: PathLike): Promise<string> {
    const exists = await this.exists(path);
    if (!exists) {
      throw new IOFail(`file ${path as string} does not exists`);
    }
    return path as string;
  }

  /**
   * read all content of file
   */
  public async read(path: string, encoding: BufferEncoding) {
    const fDesc = await open(path, 'r');
    return fDesc.readFile({ encoding });
  }

  public async readStream(path: string) {
    const fDesc = await open(path, 'r');
    return fDesc.createReadStream();
  }

  /**
   * Write to file string or buffer
   */
  public async write(path: string, data: string | Buffer, encoding: BufferEncoding) {
    const fDesc = await open(path, 'w');
    return await fDesc.writeFile(data, { encoding });
  }

  public async writeStream(path: string) {
    const fDesc = await open(path, 'w');
    return fDesc.createWriteStream();
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  public async exists(path: PathLike) {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  public async dirExists(path: PathLike) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return this.exists(path);
  }

  /**
   * Copy file to another location
   * @param path - src path
   * @param dest - dest path
   */
  public async copy(path: string, dest: string) {
    await copyFile(path, dest);
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: PathLike, newPath: PathLike) {
    try {
      await rename(oldPath, newPath);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (err.code === 'EXDEV') {
        await copyFile(oldPath, newPath);
        await unlink(oldPath);
      } else {
        throw err;
      }
    }
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: PathLike, newPath: PathLike) {
    await rename(oldPath, newPath);
  }

  /**
   * Deletes file permanently
   *
   * @param path - path to file that will be deleted
   */
  public async unlink(path: PathLike) {
    await unlink(path);
  }

  /**
   *
   * Deletes dir recursively & all contents inside
   *
   * @param path - dir to remove
   */
  public async rm(path: PathLike) {
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }

  /**
   *
   * Creates directory, recursively
   *
   * @param path - directory to create
   */
  public async mkdir(path: PathLike) {
    await mkdir(path, { recursive: true });
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  public async stat(path: PathLike): Promise<IStat> {
    const result = await stat(path);

    return {
      IsDirectory: result.isDirectory(),
      IsFile: result.isFile(),
      CreationTime: DateTime.fromJSDate(result.ctime),
      ModifiedTime: DateTime.fromJSDate(result.mtime),
      AccessTime: DateTime.fromJSDate(result.atime),
      Size: result.size,
    };
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  public async list(path: PathLike) {
    return await readdir(path);
  }
}
