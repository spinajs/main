/* eslint-disable security/detect-non-literal-fs-filename */
import { IOFail } from '@spinajs/exceptions';
import { constants, createReadStream, createWriteStream, existsSync, readFile, readFileSync, ReadStream } from 'fs';
import { rm, stat, readdir, rename, mkdir, access, open, appendFile } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { fs, IFsLocalOptions, IStat, IZipResult } from './interfaces.js';
import { basename, join } from 'path';
import { Log, Logger } from '@spinajs/log-common';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { cp, FileHandle } from 'fs/promises';
import { toArray } from '@spinajs/util';

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
    if (!this.Options.basePath) {
      throw new IOFail(`Base path for file provider ${this.Options.name} not set`);
    }

    if ((await this.exists(this.Options.basePath)) === false) {
      this.Logger.warn(
        `Base path ${this.Options.basePath} for file provider ${this.Options.name} not exists, trying to create base folder`,
      );

      await mkdir(this.Options.basePath, { recursive: true });

      this.Logger.success(`Base path ${this.Options.basePath} created`);
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
      if (fHandle) {
        await fHandle.sync();
        await fHandle.close();
      }
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
   * Copy file or dir to another location
   * @param path - src path
   * @param dest - dest path
   */
  public async copy(path: string, dest: string, dstFs?: fs) {
    const sPath = this.resolvePath(path);
    const exists = await this.exists(path);
    if (!exists) {
      throw new IOFail(`File ${path} not exists`);
    }

    if (dstFs) {
      await dstFs.upload(sPath, dest);
    } else {
      const dPath = this.resolvePath(dest);
      await cp(sPath, dPath, {
        recursive: true,
        force: true,
      });
    }
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: string, newPath: string, dstFs?: fs) {
    const oPath = this.resolvePath(oldPath);

    if (dstFs) {
      await dstFs.upload(oPath, newPath);
      await this.rm(oldPath);
    } else {
      const nPath = this.resolvePath(newPath);
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

  public async unzip(path: string, destPath?: string, dstFs?: fs) {
    const dFs = dstFs ?? this;
    const dst = dFs.resolvePath(destPath ?? dFs.tmpname());

    return new Promise<void>((resolve, reject) => {
      createReadStream(this.resolvePath(path)).pipe(
        unzipper
          .Extract({
            path: dst ,
          })
          .on('close', resolve)
          .on('error', reject),
      );
    });
  }

  public async isDir(path: string): Promise<boolean> {
    try {
      const pStat = await this.stat(path);
      return pStat.IsDirectory;
    } catch {
      return false;
    }
  }

  public async zip(path: string | string[], dstFs?: fs, dstFile?: string): Promise<IZipResult> {
    const paths = toArray(path);
    const fs = dstFs ?? (await DI.resolve<fs>('__file_provider__', ['fs-temp']));
    const outFile = dstFile ?? `${fs.tmpname()}.zip`;
    const wStream = await fs.writeStream(outFile);
    const archive = archiver('zip');

    // pipe archive data to the file
    archive.pipe(wStream);

    for (const p of paths.map((p) => this.resolvePath(p))) {
      if (await this.isDir(p)) {
        archive.directory(p, false);
        continue;
      }

      archive.file(p, { name: basename(p) });
    }

    return new Promise<IZipResult>((resolve, reject) => {
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          this.Logger.error(err, `File not found ( archiving file ), reason: ${err.message})`);
          return;
        }

        reject(new IOFail('Archiving error', err));
      });

      archive.on('error', (err) => {
        reject(new IOFail('Archiving error', err));
      });

      archive.on('entry', (entry) => {
        this.Logger.trace(`Archiving file ${entry.name}, size: ${entry.stats?.size} into ${outFile}, fs: ${fs.Name}`);
      });

      wStream.on('close', () => {
        const result = {
          fs,
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

        resolve(result);
      });

      archive.finalize();
    });
  }

  public resolvePath(path: string) {
    if (!this.Options.basePath || path.startsWith(this.Options.basePath)) return path;
    return join(this.Options.basePath, path);
  }
}
