/* eslint-disable security/detect-non-literal-fs-filename */
import { IOFail } from '@spinajs/exceptions';
import { constants, createReadStream, createWriteStream, existsSync, readFile, readFileSync, ReadStream } from 'fs';
import { rm, stat, readdir, rename, mkdir, copyFile, access, open, appendFile } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { fs, IFsLocalOptions, IStat, IZipResult } from './interfaces.js';
import { basename, join } from 'path';
import { Log, Logger } from '@spinajs/log-common';
import Util from '@spinajs/util';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { cp, FileHandle } from 'fs/promises';

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
    await cp(srcPath, dPath, { force: true, recursive: true });
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
    let fHandle: FileHandle = null;

    try {
      fHandle = await open(this.resolvePath(path), 'w');
      await fHandle.writeFile(data, { encoding });
    } catch (err) {
      throw new IOFail(`Cannot write to file ${path}`, err);
    } finally {
      if (fHandle) await fHandle.close();
    }
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
  public async copy(path: string, dest: string, dstFs?: fs) {
    if (dstFs) {
      await dstFs.upload(this.resolvePath(path), dest);
    } else {
      await copyFile(this.resolvePath(path), this.resolvePath(dest));
    }
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: string, newPath: string, dstFs?: fs) {
    const oPath = this.resolvePath(oldPath);
    const nPath = this.resolvePath(newPath);

    if (dstFs) {
      await dstFs.upload(oPath, newPath);
      await this.rm(oldPath);
    } else {
      await rename(oPath, nPath);
    }
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: string, newPath: string) {
    await rename(this.resolvePath(oldPath), this.resolvePath(newPath));
  }

  /**
   *
   * Deletes file OR
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

  public async unzip(path: string, destPath: string, dstFs?: fs) {
    const tmpFs = await DI.resolve<fs>('__file_provider__', ['fs-temp']);
    const dst = dstFs ? tmpFs.tmpname() : destPath;

    return new Promise<void>((resolve, reject) => {
      createReadStream(this.resolvePath(path)).pipe(
        unzipper
          .Extract({
            path: dst,
          })
          .on('close', () => {
            if (dstFs) {
              tmpFs.move(dst, destPath, dstFs).then(resolve).catch(reject);
            } else {
              resolve();
            }
          })
          .on('error', reject),
      );
    });
  }

  public async isDir(path: string): Promise<boolean> {
    const pStat = await this.stat(path);
    return pStat.IsDirectory;
  }

  public async zip(path: string | string[], dstFs?: fs): Promise<IZipResult> {
    const fs = dstFs ?? (await DI.resolve<fs>('__file_provider__', ['fs-temp']));

    const outFile = join(fs.tmpname(), '.zip');
    const wStream = await fs.writeStream(outFile);
    const paths = Util.Array.toArray(path);
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Sets the compression level.
    });

    // pipe archive data to the file
    archive.pipe(wStream);

    paths
      .map((p) => this.resolvePath(p))
      .forEach((p) => {
        this.isDir(p) ? archive.directory(p, false) : archive.file(p, { name: basename(p) });
      });

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

      unlink: async () => {
        return await fs.rm(outFile);
      },
    };
  }

  public resolvePath(path: string) {
    if (!this.Options.basePath) return path;

    if (path.startsWith(this.Options.basePath)) {
      return path;
    }

    return join(this.Options.basePath, path);
  }
}
