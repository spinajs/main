/* eslint-disable security/detect-non-literal-fs-filename */
import { IOFail } from '@spinajs/exceptions';
import {
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readFile,
  readFileSync,
  ReadStream,
} from 'fs';
import { unlink, rm, stat, readdir, rename, mkdir, copyFile, access, open, appendFile } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { fs, IFsLocalOptions, IStat, IZipResult } from './interfaces.js';
import { basename, join } from 'path';
import { Log, Logger } from '@spinajs/log-common';
import archiver from 'archiver';
import unzipper from 'unzipper';

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
export class fsNative<T extends IFsLocalOptions> extends fs {
  @Logger('fs')
  protected Logger: Log;

  /**
   * Name of provider. We can have multiple providers of the same type but with different options.
   * Also used in InjectService decorator for mapping
   */
  public get Name(): string {
    return this.Options.name;
  }

  constructor(public Options: T) {
    super();
  }

  public async resolve() {
    if (this.Options.basePath) {
      // yup, exceptions as conditional execution path is bad :)
      try {
        await access(this.Options.basePath, constants.F_OK);
      } catch {
        this.Logger.warn(
          `Base path ${this.Options.basePath} for file provider ${this.Options.name} not exists, trying to create base folder`,
        );

        await mkdir(this.Options.basePath, { recursive: true });

        this.Logger.success(`Base path ${this.Options.basePath} created`);
      }
    }
  }

  /**
   *
   * Tries to download file to local filesystem, then returns local filesystem path.
   * Native implementation simply returns local path and does nothing.
   *
   * @param path - file to download
   */
  public async download(path: string): Promise<string> {
    const p = this.resolvePath(path);
    const exists = await this.exists(path);
    if (!exists) {
      throw new IOFail(`file ${p} does not exists`);
    }
    return p;
  }

  public async upload(srcPath: string, destPath?: string) {
    if (!existsSync(srcPath)) {
      throw new IOFail(`file ${srcPath} does not exists`);
    }

    const dPath = this.resolvePath(destPath ?? basename(srcPath));
    copyFileSync(srcPath, dPath);
  }

  /**
   * read all content of file
   */
  public async read(path: string, encoding?: BufferEncoding) {
    return new Promise<string | Buffer>((resolve, reject) => {
      readFile(this.resolvePath(path), { encoding: encoding ?? 'binary' }, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  public readStream(path: string, encoding?: BufferEncoding) {
    return Promise.resolve(createReadStream(this.resolvePath(path), { encoding: encoding ?? 'binary' }));
  }

  /**
   * Write to file string or buffer
   */
  public async write(path: string, data: string | Buffer, encoding: BufferEncoding) {
    const fDesc = await open(this.resolvePath(path), 'w');
    return await fDesc.writeFile(data, { encoding });
  }

  public async append(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void> {
    await appendFile(path, data, encoding);
  }

  public writeStream(path: string, rStream?: BufferEncoding | ReadStream, encoding?: BufferEncoding) {
    return Promise.resolve(
      createWriteStream(this.resolvePath(path), {
        encoding: (typeof rStream === 'string' ? rStream : encoding) ?? 'binary',
      }),
    );
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  public async exists(path: string) {
    try {
      await access(this.resolvePath(path), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  public async dirExists(path: string) {
    return this.exists(this.resolvePath(path));
  }

  /**
   * Copy file to another location
   * @param path - src path
   * @param dest - dest path
   */
  public async copy(path: string, dest: string) {
    await copyFile(this.resolvePath(path), this.resolvePath(dest));
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: string, newPath: string) {
    const oPath = this.resolvePath(oldPath);
    const nPath = this.resolvePath(newPath);
    try {
      await rename(oPath, nPath);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (err.code === 'EXDEV') {
        await copyFile(oPath, nPath);
        await unlink(oPath);
      } else {
        throw err;
      }
    }
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: string, newPath: string) {
    await rename(this.resolvePath(oldPath), this.resolvePath(newPath));
  }

  /**
   * Deletes file permanently
   *
   * @param path - path to file that will be deleted
   * @param onlyTemp - remote filesystems need to download file before, if so, calling unlink with this flag removes only local temp file after we finished processing
   */
  public async unlink(path: string, onlyTemp?: boolean) {
    // local fs returns only local path to file, we dont want to delete it
    if (onlyTemp) {
      return;
    }

    await unlink(this.resolvePath(path));
  }

  /**
   *
   * Deletes dir recursively & all contents inside
   *
   * @param path - dir to remove
   */
  public async rm(path: string) {
    await rm(this.resolvePath(path), { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }

  /**
   *
   * Creates directory, recursively
   *
   * @param path - directory to create
   */
  public async mkdir(path: string) {
    await mkdir(this.resolvePath(path), { recursive: true });
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  public async stat(path: string): Promise<IStat> {
    const result = await stat(this.resolvePath(path));

    return {
      IsDirectory: result.isDirectory(),
      IsFile: result.isFile(),
      CreationTime: DateTime.fromJSDate(result.ctime),
      ModifiedTime: DateTime.fromJSDate(result.mtime),
      AccessTime: DateTime.fromJSDate(result.atime),
      Size: result.size,
    };
  }

  public tmppath(): string {
    return join(this.Options.basePath, super.tmpname());
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  public async list(path: string) {
    return await readdir(this.resolvePath(path));
  }

  public async unzip(path: string, destPath: string) {
    return new Promise<void>((resolve, reject) => {
      createReadStream(this.resolvePath(path)).pipe(
        unzipper
          .Extract({
            path: this.resolvePath(destPath),
          })
          .on('close', resolve)
          .on('error', reject),
      );
    });
  }

  public async zip(path: string, zName?: string): Promise<IZipResult> {
    const fs = await DI.resolve<fs>('__file_provider__', ['fs-temp']);

    const outFile = fs.resolvePath(fs.tmpname() + '.zip');
    const output = createWriteStream(outFile);
    const pStat = await this.stat(path);
    const fPath = this.resolvePath(path);
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Sets the compression level.
    });

    // pipe archive data to the file
    archive.pipe(output);

    if (pStat.IsDirectory) {
      archive.directory(fPath, false);
    } else {
      archive.file(fPath, { name: zName ?? basename(fPath) });
    }

    await archive.finalize();

    return {
      asFilePath: () => {
        return outFile;
      },
      asStream: (encoding?: BufferEncoding) => {
        return createReadStream(outFile, {
          encoding: encoding ?? 'binary',
        });
      },
      asBase64: () => {
        return readFileSync(outFile, { encoding: 'base64' });
      },
    };
  }

  public resolvePath(path: string) {

    if(!this.Options.basePath) return path;

    if (path.startsWith(this.Options.basePath)) {
      return path;
    }

    return join(this.Options.basePath, path);
  }
}
