import { Autoinject, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, IStat, IZipResult, FileSystem, FileInfoService } from '@spinajs/fs';
import { Client } from 'basic-ftp';
import path from 'path';
import { IOFail, MethodNotImplemented } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
import { PassThrough, Readable } from 'stream';

interface IFtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure?: boolean;
  logVerbose: boolean;
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
export class fsFTP extends fs {
  @Logger('fs')
  protected Logger: Log;

  @Autoinject()
  protected FileInfo: FileInfoService;

  /**
   * File system for temporary files
   */
  @FileSystem('fs-temp')
  protected TempFs: fs;

  protected FtpClient: Client;

  /**
   * Name of provider. We can have multiple providers of the same type but with different options.
   * Also used in InjectService decorator for mapping
   */
  public get Name(): string {
    return this.Options.name;
  }

  constructor(public Options: IFtpConfig) {
    super();
  }

  protected async _ensureDir(dir: string) {
    const dstDir = path.dirname(dir);
    await this.FtpClient.ensureDir(dstDir);
    await this._setWorkingDir(dir);
  }

  protected async _setWorkingDir(dir: string) {
    const dstDir = path.dirname(dir);
    await this.FtpClient.cd(dstDir === '.' ? dstDir : `/${dstDir}`);
  }

  protected async _restoreRootDir() {
    const pwd = await this.FtpClient.pwd();
    if (pwd !== '/') {
      const paths = pwd.split('/');
      for (let index = 0; index < paths.length; index++) {
        await this.FtpClient.cd('..');
      }
    }
  }

  public async resolve() {
    
    await super.resolve();

    this.FtpClient = new Client();
    this.FtpClient.ftp.verbose = this.Options.logVerbose;

    this.FtpClient.ftp.log = (msg) => {
      this.Logger.debug(msg);
    };

    try {
      await this.FtpClient.access({
        host: this.Options.host,
        port: this.Options.port ?? 21,
        user: this.Options.user,
        password: this.Options.password,
        secure: this.Options.secure ?? false,
      });

      this.Logger.info(`Connected to ftp server at ${this.Options.host}:${this.Options.port}`);

      this.FtpClient.trackProgress((info) => {
        const cmd = info.name ? `file: ${info.name}` : `command: ${info.type}`;
        this.Logger.debug(`Progress - ${cmd}, transferred: ${info.bytes} of total ${info.bytesOverall} bytes`);
      });
    } catch (e) {
      throw new IOFail(`Cannot connect to ftp server: ${e.message}`);
    }
  }

  /**
   *
   * Tries to download file to local filesystem, then returns local filesystem path.
   * Native implementation simply returns local path and does nothing.
   *
   * @param path - file to download
   */
  public async download(p: string): Promise<string> {
    const tmpName = this.TempFs.tmppath();
    const wStream = await this.TempFs.writeStream(tmpName);

    await this._restoreRootDir();
    await this._setWorkingDir(p);
    await this.FtpClient.downloadTo(wStream, path.basename(p));

    this.Logger.debug(`Downloaded file ${p} to ${tmpName}`);

    return tmpName;
  }

  /**
   * read all content of file
   */
  public async read(path: string, encoding: BufferEncoding) {
    const tmpName = await this.download(path);
    const data = await this.TempFs.read(tmpName, encoding);

    await this.TempFs.rm(tmpName);

    return data;
  }

  /**
   * Returns a readable stream with the remote file content.
   *
   * NOTE: basic-ftp runs one command at a time on a single connection - do not
   * issue other operations on this provider until the stream is fully consumed.
   */
  public async readStream(p: string, encoding?: BufferEncoding): Promise<any> {
    const pass = new PassThrough();

    if (encoding) {
      pass.setEncoding(encoding);
    }

    await this._restoreRootDir();
    await this._setWorkingDir(p);

    this.FtpClient.downloadTo(pass, path.basename(p)).catch((err) => {
      pass.destroy(err instanceof Error ? err : new IOFail(`Cannot read stream from ${p}`, err));
    });

    return pass;
  }

  /**
   * Write to file string or buffer
   */
  public async write(dstPath: string, data: string | Buffer, encoding?: BufferEncoding) {
    await this._restoreRootDir();
    await this._ensureDir(dstPath);
    await this.FtpClient.uploadFrom(Readable.from(data, { encoding }), path.basename(dstPath));
  }

  /**
   * @param path
   * @param data
   * @param encoding
   */
  public async append(dstPath: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void> {
    await this._restoreRootDir();
    await this._ensureDir(dstPath);

    // use the FTP APPE command ( appendFrom ) so data is appended to the existing
    // remote file. After _ensureDir the working dir is the file's parent, so the
    // remote target must be the basename.
    await this.FtpClient.appendFrom(Readable.from(data, { encoding }), path.basename(dstPath));
  }

  public async upload(srcPath: string, destPath?: string) {
    await this._restoreRootDir();
    
    if (!destPath) {
      destPath = path.basename(srcPath);
    }
    
    await this._ensureDir(destPath!);

    // upload under the destination file name, not the source name. _ensureDir has
    // already switched into destPath's parent directory, so pass the destination basename.
    await this.FtpClient.uploadFrom(srcPath, path.basename(destPath!));
  }

  /**
   *
   * Returns writable stream for given path
   *
   * @param path file path ( relative to base path of provider)
   * @param rStream readable stream, must be provided beforehand
   * @param encoding optional stream encoding
   */
  public async writeStream(_path: string, _encoding?: BufferEncoding | NodeJS.ReadableStream, _enc?: BufferEncoding): Promise<any> {
    throw new MethodNotImplemented('fs ftp does not support writing streams');
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  public async exists(p: string) {
    try {
      await this._restoreRootDir();
      await this._setWorkingDir(p);

      const result = await this.stat(path.basename(p));
      if (!result) {
        return false;
      }
      return result.IsFile ?? false;
    } catch (e) {
      return false;
    }
  }

  public async dirExists(p: string): Promise<boolean> {
    try {
      await this._restoreRootDir();
      await this._setWorkingDir(p);

      const result = await this.stat(path.basename(p));
      return !!(result && result.IsDirectory);
    } catch {
      return false;
    }
  }

  /**
   * Copy file to another location of fs
   *
   * FTP implementation does not support copying locally, so we must download it locally, then copy onto ftp server
   *
   * @param path - src path
   * @param dest - dest path
   * @param dstFs - destination file system ( optional )
   */
  public async copy(path: string, dest: string, dstFs?: fs) {
    let tmpFile = '';

    try {
      tmpFile = await this.download(path);
      if (dstFs) {
        await dstFs.upload(tmpFile, dest);
      } else {
        await this.FtpClient.uploadFrom(tmpFile, dest);
      }
    } finally {
      if (tmpFile) {
        await this.TempFs.rm(tmpFile);
      }
    }
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: string, newPath: string, dstFs?: fs) {
    if (dstFs) {
      let tmpFile = '';
      try {
        tmpFile = await this.download(oldPath);
        await dstFs.upload(tmpFile, newPath);
        await this.FtpClient.remove(oldPath);
      } finally {
        if (tmpFile) {
          await this.TempFs.rm(tmpFile);
        }
      }
    } else {
      // rename also can move file betwen directories
      await this.FtpClient.rename(oldPath, newPath);
    }
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: string, newPath: string) {
    await this.FtpClient.rename(oldPath, newPath);
  }

  /**
   *
   * Deletes dir recursively & all contents inside
   *
   * @param path - dir to remove
   */
  public async rm(p: string) {
    await this._restoreRootDir();
    await this._setWorkingDir(p);
    await this.FtpClient.remove(path.basename(p));
  }

  /**
   *
   * Creates directory, recursively
   *
   */
  public async mkdir(path: string) {
    await this.FtpClient.ensureDir(path);
  }

  public async isDir(dir: string): Promise<boolean> {
    const stat = await this.stat(dir);
    return stat.IsDirectory ?? false;
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  public async stat(file: string): Promise<IStat> {
    await this.FtpClient.cd(path.dirname(file));
    const files = await this.FtpClient.list(path.basename(file));
    const found = files.find((f) => f.name === path.basename(file));
    if (found) {
      return {
        IsDirectory: found.isDirectory,
        IsFile: found.isFile,
        Size: found.size,
        AccessTime: undefined,
        ModifiedTime: DateTime.fromJSDate(found.modifiedAt!),
        CreationTime: undefined,
        AdditionalData: found,
      };
    }

    return null as any;
  }

  public tmppath(): string {
    throw new MethodNotImplemented('fs ftp does not support temporary paths');
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  public async list(dir: string) {
    await this.FtpClient.cd(path.dirname(dir));
    const files = await this.FtpClient.list(path.basename(dir));
    return files.map((f) => f.name);
  }

  /**
   * Downloads the zip to the local temp fs and extracts it there.
   * Destination fs must be a local-path filesystem ( defaults to the temp fs ) -
   * extracting directly onto the ftp server is not supported.
   */
  public async unzip(srcPath: string, destPath?: string, dstFs?: fs): Promise<string> {
    const local = await this.download(srcPath);

    try {
      return await this.TempFs.unzip(local, destPath, dstFs ?? this.TempFs);
    } finally {
      try {
        await this.TempFs.rm(local);
      } catch {
        /* best effort cleanup */
      }
    }
  }

  /**
   * Downloads given remote files to the local temp fs and zips them there.
   * Result is created on dstFs ( defaults to the temp fs ). Entry names are the
   * remote path basenames.
   */
  public async zip(p: string | (string | string[])[], dstFs?: fs, dstFile?: string): Promise<IZipResult> {
    const paths = Array.isArray(p) ? p : [p];
    const downloaded: [string, string][] = [];

    try {
      for (const entry of paths) {
        const remote = Array.isArray(entry) ? entry[0] : entry;
        const entryName = Array.isArray(entry) ? entry[1] : entry;
        const local = await this.download(remote);
        downloaded.push([local, entryName]);
      }

      return await this.TempFs.zip(downloaded, dstFs ?? this.TempFs, dstFile);
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

  public resolvePath(_path: string): string {
    // we checek if path is absolute
    // for hash function
    if (path.isAbsolute(_path)) {
      return _path;
    }

    throw new MethodNotImplemented('fs ftp does not support path resolving');
  }
}
