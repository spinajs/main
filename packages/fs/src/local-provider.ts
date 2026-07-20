/* eslint-disable security/detect-non-literal-fs-filename */
import { IOFail } from '@spinajs/exceptions';
import { constants, createReadStream, createWriteStream, existsSync, readFileSync, Stats } from 'fs';
import { tmpdir } from 'os';
import { rm, stat, readdir, rename, mkdir, access, open, appendFile, readFile } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { fs, IFsLocalOptions, IStat, IZipResult } from './interfaces.js';
import { basename, dirname, isAbsolute, join, parse, relative, resolve as pathResolve } from 'path';
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
 * All failures are surfaced as IOFail ( the original error is preserved as the
 * inner cause ). When basePath is set, all paths are sandboxed to it - resolved
 * paths escaping basePath ( eg. via `..` ) throw IOFail.
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

    if (!this.Options) {
      throw new IOFail('Options for fs provider not provided, cannot create fs provider instance');
    }
  }

  public async resolve() {
    await super.resolve();

    // canonicalize configured base path once - a relative basePath would otherwise
    // resolve against cwd at every call ( and self-join in checks below )
    if (this.Options.basePath) {
      this.Options.basePath = pathResolve(this.Options.basePath);
    }

    const basePath = this.Options.basePath ?? process.env.WORKSPACE_ROOT_PATH ?? process.cwd();

    this.Logger.info(`Initializing file provider ${this.Options.name} with base path ${basePath}`);

    // check the raw path - this.exists() would resolve it against basePath again
    if (!existsSync(basePath)) {
      this.Logger.warn(
        `Base path ${basePath} for file provider ${this.Options.name} not exists, trying to create base folder`,
      );

      // use the computed base path - Options.basePath may be undefined when the
      // env / cwd fallback was taken
      await mkdir(basePath, { recursive: true });

      this.Logger.success(`Base path ${basePath} created`);
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

    try {
      // cp creates missing destination parent directories itself
      await cp(srcPath, dPath, { force: true, recursive: true });
    } catch (err) {
      throw new IOFail(`Cannot upload ${srcPath} to ${dPath}`, err);
    }
  }

  /**
   * read all content of file
   */
  public async read(path: string, encoding?: BufferEncoding) {
    const p = this.resolvePath(path);

    try {
      // no encoding -> raw Buffer. Defaulting to 'binary' ( latin1 ) would return
      // a string and corrupt binary data for callers expecting a Buffer.
      return await readFile(p, { encoding: encoding ?? null });
    } catch (err) {
      throw new IOFail(`Cannot read file ${path}`, err);
    }
  }

  public async readStream(path: string, encoding?: BufferEncoding) {
    const p = this.resolvePath(path);

    // fail fast with a consistent error - otherwise the error surfaces asynchronously
    // on the returned stream. NOTE: runtime read failures are still stream errors.
    if (!(await this.exists(path))) {
      throw new IOFail(`Cannot read file ${path}, file does not exists`);
    }

    return createReadStream(p, encoding ? { encoding } : {});
  }

  /**
   * Write to file string or buffer
   */
  public async write(path: string, data: string | Uint8Array, encoding?: BufferEncoding) {
    const p = this.resolvePath(path);

    let fHandle: FileHandle;
    try {
      fHandle = await open(p, 'w');
    } catch (err) {
      throw new IOFail(`Cannot open file ${path} for writing`, err);
    }

    try {
      await fHandle.writeFile(data, { encoding });

      // flush to disk so data is durable before success is reported
      await fHandle.sync();
    } catch (err) {
      throw new IOFail(`Cannot write to file ${path}`, err);
    } finally {
      // close must ALWAYS run and must never mask the original error
      await fHandle.close().catch(() => {});
    }
  }

  public async append(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const p = this.resolvePath(path);

    try {
      await appendFile(p, data, encoding);
    } catch (err) {
      throw new IOFail(`Cannot append to file ${path}`, err);
    }
  }

  public writeStream(path: string, rStream?: BufferEncoding | NodeJS.ReadableStream, encoding?: BufferEncoding) {
    const enc = typeof rStream === 'string' ? rStream : encoding;
    const stream = createWriteStream(this.resolvePath(path), enc ? { encoding: enc } : {});

    // pipe ANY readable stream, not only fs.ReadStream instances - the contract accepts
    // NodeJS.ReadableStream ( PassThrough, http/s3 bodies etc. ), instanceof would
    // silently skip those and stall the caller
    if (rStream && typeof rStream !== 'string' && typeof rStream.pipe === 'function') {
      // pipe() does NOT forward errors - without this, a failing source leaves the
      // write stream open forever and the caller waiting for 'close' hangs
      rStream.on('error', (err) => stream.destroy(err instanceof Error ? err : new IOFail(String(err))));
      rStream.pipe(stream);
    }

    return Promise.resolve(stream);
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
    return this.isDir(path);
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

      try {
        await cp(sPath, dPath, {
          recursive: true,
          force: true,
        });
      } catch (err) {
        throw new IOFail(`Cannot copy ${path} to ${dest}`, err);
      }
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
      return;
    }

    const nPath = this.resolvePath(newPath);

    // rename does not create missing destination directories - align with copy
    // ( cp creates them ). Failures here are ignored, rename reports the real error.
    await mkdir(dirname(nPath), { recursive: true }).catch(() => {});

    try {
      await this._rename(oPath, nPath);
    } catch (err) {
      // rename cannot cross devices / mounts ( eg. C: -> D:, docker volumes ) -
      // fall back to copy + delete
      if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
        await cp(oPath, nPath, { recursive: true, force: true });
        await this.rm(oldPath);
        return;
      }

      throw new IOFail(`Cannot move ${oldPath} to ${newPath}`, err);
    }
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: string, newPath: string) {
    const oPath = this.resolvePath(oldPath);
    const nPath = this.resolvePath(newPath);

    try {
      await this._rename(oPath, nPath);
    } catch (err) {
      throw new IOFail(`Cannot rename ${oldPath} to ${newPath}`, err);
    }
  }

  /**
   * Native rename seam - extracted so move/rename logic ( eg. EXDEV fallback )
   * can be tested without a real cross-device setup.
   */
  protected _rename(oldPath: string, newPath: string): Promise<void> {
    return rename(oldPath, newPath);
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
    const p = this.resolvePath(path);

    try {
      await mkdir(p, { recursive: true });
    } catch (err) {
      throw new IOFail(`Cannot create directory ${path}`, err);
    }
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  public async stat(path: string): Promise<IStat> {
    const p = this.resolvePath(path);

    try {
      return this.toStatEntry(await stat(p));
    } catch (err) {
      throw err instanceof IOFail ? err : new IOFail(`Cannot stat ${path}`, err);
    }
  }

  /**
   * Maps native fs.Stats onto IStat.
   *
   * birthtime is the creation time; ctime is inode CHANGE time and would reset
   * file age on chmod / rename ( breaks temp fs cleanup ageing ). Defensive:
   * some filesystems report epoch 0 when birthtime is unsupported - fall back
   * to mtime so age-based logic does not treat files as infinitely old.
   */
  protected toStatEntry(result: Stats): IStat {
    const birth = result.birthtime && result.birthtime.getTime() > 0 ? result.birthtime : result.mtime;

    return {
      IsDirectory: result.isDirectory(),
      IsFile: result.isFile(),
      CreationTime: DateTime.fromJSDate(birth),
      ModifiedTime: DateTime.fromJSDate(result.mtime),
      AccessTime: DateTime.fromJSDate(result.atime),
      Size: result.size,
    };
  }

  public tmppath(ext?: string): string {
    return join(this.Options.basePath!, super.tmpname(ext));
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  public async list(path: string) {
    const p = this.resolvePath(path);

    try {
      return await readdir(p);
    } catch (err) {
      throw new IOFail(`Cannot list directory ${path}`, err);
    }
  }

  public async unzip(path: string, destPath?: string, dstFs?: fs) {
    const srcPath = this.resolvePath(path);

    if (!(await this.exists(path))) {
      throw new IOFail(`Cannot unzip, file ${path} does not exists`);
    }

    const dFs = dstFs ?? this;
    const dst = dFs.resolvePath(destPath ?? dFs.tmpname());

    return new Promise<string>((resolve, reject) => {
      const rStream = createReadStream(srcPath);

      // without this handler a source read error is an unhandled stream 'error'
      // event and CRASHES the process instead of rejecting
      rStream.on('error', (err) => reject(new IOFail(`Cannot read zip file ${path}`, err)));

      rStream.pipe(
        unzipper
          .Extract({
            path: dst,
          })
          .on('close', () => resolve(dst))
          .on('error', (err) => reject(new IOFail(`Cannot unzip file ${path}`, err))),
      );
    });
  }

  public async isDir(path: string): Promise<boolean> {
    try {
      const pStat = await this.stat(path);
      return pStat.IsDirectory ?? false;
    } catch {
      return false;
    }
  }

  public async zip(path: string | (string | string[])[], dstFs?: fs, dstFile?: string): Promise<IZipResult> {
    const paths = toArray(path as any) as (string | string[])[];

    await this.assertSourcesExist(paths);

    const fs = dstFs ?? (await DI.resolve<fs>('__file_provider__', ['fs-temp']));
    const outFile = dstFile ?? `${fs.tmpname()}.zip`;
    const wStream = await fs.writeStream(outFile);
    const archive = archiver('zip');

    // pipe archive data to the file
    archive.pipe(wStream);

    await this.addZipEntries(archive, paths);

    archive.on('entry', (entry) => {
      this.Logger.trace(`Archiving file ${entry.name}, size: ${entry.stats?.size} into ${outFile}, fs: ${fs.Name}`);
    });

    archive.on('progress', (entry) => {
      this.Logger.trace(
        `Entries ${entry.entries.total}/${entry.entries.processed}, fs: ${entry.fs.totalBytes}/${entry.fs.processedBytes}`,
      );
    });

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

      wStream.on('close', () => {
        resolve(this.buildZipResult(fs, outFile));
      });

      // finalize() also reports failures via its returned promise - catch it so a
      // failure is not an unhandled rejection on top of the 'error' event
      archive.finalize().catch((err) => reject(new IOFail('Archiving error', err)));
    });
  }

  /**
   * Source path of a zip entry. Entries are either a plain path or a
   * [ sourcePath, entryName ] tuple.
   */
  protected zipEntrySource(entry: string | string[]): string {
    return Array.isArray(entry) ? entry[0] : entry;
  }

  /**
   * Name a zip entry is stored under. Defaults to the source path when no
   * explicit entry name is given.
   */
  protected zipEntryName(entry: string | string[]): string {
    return Array.isArray(entry) ? entry[1] : entry;
  }

  /**
   * Fails fast with a single clear error listing every missing source, so a
   * missing entry never yields a silently incomplete archive.
   */
  protected async assertSourcesExist(paths: (string | string[])[]): Promise<void> {
    const missing: string[] = [];
    for (const p of paths) {
      const src = this.zipEntrySource(p);
      if (!(await this.exists(src))) {
        missing.push(src);
      }
    }

    if (missing.length > 0) {
      throw new IOFail(`Cannot zip, source path(s) not found: ${missing.join(', ')}`);
    }
  }

  /**
   * Adds every source to the archive - a plain-path directory is added
   * recursively, everything else as a single file stored under its entry name.
   */
  protected async addZipEntries(archive: ReturnType<typeof archiver>, paths: (string | string[])[]): Promise<void> {
    for (const p of paths) {
      if (!Array.isArray(p) && (await this.isDir(p))) {
        archive.directory(this.resolvePath(p), false);
        continue;
      }

      archive.file(this.resolvePath(this.zipEntrySource(p)), { name: basename(this.zipEntryName(p)) });
    }
  }

  /**
   * Builds the {@link IZipResult} accessor object for a finished archive.
   *
   * The zip path is resolved against the DESTINATION fs ( outFile is relative
   * to its base path ). Remote destinations may not support path resolving -
   * fall back to the raw name so the accessors still work.
   */
  protected buildZipResult(fs: fs, outFile: string): IZipResult {
    let zipPath = outFile;
    try {
      zipPath = fs.resolvePath(outFile);
    } catch {
      /* keep outFile as-is */
    }

    return {
      fs,
      asFilePath: () => zipPath,
      asStream: (encoding?: BufferEncoding) => createReadStream(zipPath, encoding ? { encoding } : {}),
      asBase64: () => readFileSync(zipPath, { encoding: 'base64' }),
      unlink: async () => await fs.rm(outFile),
    };
  }

  public resolvePath(path: string) {
    if (!this.Options.basePath) return path;

    const base = this.Options.basePath;

    if (isAbsolute(path)) {
      // absolute path already inside basePath is returned as-is. Using
      // path.relative instead of startsWith avoids false positives on sibling
      // directories (eg. basePath `/data/files` and path `/data/files-2/x`)
      // and is separator-safe across platforms.
      const rel = relative(base, path);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return path;
      }

      // fully-qualified paths ( drive letter / UNC on windows ) outside the
      // sandbox are rejected. Rooted-but-driveless paths ( `/x`, `\x` ) are the
      // established "fs root" idiom ( eg. list('/') ) and fall through to be
      // resolved relative to basePath, exactly like join() always treated them.
      const root = parse(path).root;
      if (root !== '/' && root !== '\\') {
        throw new IOFail(`Path ${path} is outside of filesystem base path ( ${base} ), fs: ${this.Options.name}`);
      }
    }

    // join normalizes `..` segments - verify the result still lives inside basePath
    // so relative paths cannot escape the sandbox ( eg. ../../etc/passwd )
    const joined = join(base, path);
    const rel = relative(base, joined);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new IOFail(`Path ${path} escapes filesystem base path ( ${base} ), fs: ${this.Options.name}`);
    }

    return joined;
  }
}
