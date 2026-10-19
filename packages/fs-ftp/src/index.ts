import { Autoinject, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, IStat, IZipResult, FileSystem, FileInfoService, FileHasher, IFileInfo } from '@spinajs/fs';
import { Client } from 'basic-ftp';
import path from 'path';
import { IOFail, MethodNotImplemented, ResourceDuplicated } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
import { PassThrough, Readable } from 'stream';
import type { IFsUploadOptions } from '@spinajs/fs';

export interface IFtpConfig {
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
    await this.FtpClient.cd(dstDir === '.' || dstDir.startsWith('/') ? dstDir : `/${dstDir}`);
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

    // replacing log() drops basic-ftp's own verbose check, so it is repeated here
    this.FtpClient.ftp.log = (msg) => {
      if (this.FtpClient.ftp.verbose) {
        this.Logger.debug(msg);
      }
    };

    try {
      await this.FtpClient.access({
        host: this.Options.host,
        port: this.Options.port ?? 21,
        user: this.Options.user,
        password: this.Options.password,
        secure: this.Options.secure ?? false,
      });

      this.Logger.info({ host: this.Options.host, port: this.Options.port }, 'Connected to ftp server at ${host}:${port}');

      this.FtpClient.trackProgress((info) => {
        this.Logger.debug(
          { ...(info.name ? { file: info.name } : { command: info.type }), bytes: info.bytes, bytesOverall: info.bytesOverall },
          'Progress - ${?file}file: ${file}${/file}${?command}command: ${command}${/command}, transferred: ${bytes} of total ${bytesOverall} bytes',
        );
      });
    } catch (e) {
      throw new IOFail(`Cannot connect to ftp server: ${e.message}`);
    }
  }

  public async dispose(): Promise<void> {
    this.FtpClient?.close();
    await super.dispose();
  }

  /**
   *
   * Tries to download file to local filesystem, then returns local filesystem path.
   * Native implementation simply returns local path and does nothing.
   *
   * @param path - file to download
   */
  protected async doDownload(p: string): Promise<string> {
    const tmpName = this.TempFs.tmppath(path.extname(p));
    const wStream = await this.TempFs.writeStream(tmpName);

    await this._restoreRootDir();
    await this._setWorkingDir(p);
    await this.FtpClient.downloadTo(wStream, path.basename(p));

    this.Logger.debug({ path: p, tmpName }, 'Downloaded file ${path} to ${tmpName}');

    return tmpName;
  }

  /**
   * read all content of file
   */
  protected async doRead(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const tmpName = await this.download(path);

    try {
      return await this.TempFs.read(tmpName, encoding);
    } finally {
      await this.TempFs.rm(tmpName);
    }
  }

  /**
   * Returns a readable stream with the remote file content.
   *
   * NOTE: basic-ftp runs one command at a time on a single connection - do not
   * issue other operations on this provider until the stream is fully consumed.
   */
  protected async doReadStream(p: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
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
  protected async doWrite(dstPath: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    await this._restoreRootDir();
    await this._ensureDir(dstPath);
    await this.FtpClient.uploadFrom(Readable.from(this._bytes(data), { encoding }), path.basename(dstPath));
  }

  /**
   * @param path
   * @param data
   * @param encoding
   */
  protected async doAppend(dstPath: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    await this._restoreRootDir();
    await this._ensureDir(dstPath);

    // use the FTP APPE command ( appendFrom ) so data is appended to the existing
    // remote file. After _ensureDir the working dir is the file's parent, so the
    // remote target must be the basename.
    await this.FtpClient.appendFrom(Readable.from(this._bytes(data), { encoding }), path.basename(dstPath));
  }

  // Readable.from emits a string or a Buffer as one chunk but iterates any other Uint8Array byte by byte.
  protected _bytes(data: string | Uint8Array): string | Buffer {
    return typeof data === 'string' || Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  protected async doUpload(srcPath: string, destPath: string, options?: IFsUploadOptions): Promise<void> {
    // FTP has no create-if-absent: another client can still create the file between this check and the upload
    if (options?.exclusive && (await this.exists(destPath))) {
      throw new ResourceDuplicated(`Cannot upload ${srcPath}, ${destPath} already exists`);
    }

    await this._restoreRootDir();
    await this._ensureDir(destPath);

    // upload under the destination file name, not the source name. _ensureDir has
    // already switched into destPath's parent directory, so pass the destination basename.
    await this.FtpClient.uploadFrom(srcPath, path.basename(destPath));
  }

  /**
   *
   * Returns writable stream for given path
   *
   * @param path file path ( relative to base path of provider)
   * @param rStream readable stream, must be provided beforehand
   * @param encoding optional stream encoding
   */
  protected async doWriteStream(_path: string, _readStream?: NodeJS.ReadableStream | BufferEncoding, _encoding?: BufferEncoding): Promise<PassThrough> {
    throw new MethodNotImplemented('fs ftp does not support writing streams');
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  protected async doExists(p: string): Promise<boolean> {
    try {
      const result = await this.stat(p);
      return result?.IsFile ?? false;
    } catch (e) {
      return false;
    }
  }

  protected async doDirExists(p: string): Promise<boolean> {
    try {
      const result = await this.stat(p);
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
  protected async doCopy(path: string, dest: string, dstFs?: fs): Promise<void> {
    let tmpFile = '';

    try {
      tmpFile = await this.download(path);
      if (dstFs) {
        await dstFs.upload(tmpFile, dest);
      } else {
        await this.upload(tmpFile, dest);
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
  protected async doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    if (dstFs) {
      let tmpFile = '';
      try {
        tmpFile = await this.download(oldPath);
        await dstFs.upload(tmpFile, newPath);
        await this.rm(oldPath);
      } finally {
        if (tmpFile) {
          await this.TempFs.rm(tmpFile);
        }
      }
    } else {
      // rename also can move file betwen directories
      await this.rename(oldPath, newPath);
    }
  }

  /**
   * Change name of a file
   */
  protected async doRename(oldPath: string, newPath: string): Promise<void> {
    await this._restoreRootDir();
    await this.FtpClient.rename(oldPath, newPath);
  }

  /**
   *
   * Deletes file, or dir recursively & all contents inside
   *
   * @param path - file or dir to remove
   */
  protected async doRm(p: string): Promise<void> {
    // stat() leaves the working dir at p's parent
    const stat = await this.stat(p);

    if (stat?.IsDirectory) {
      await this.FtpClient.removeDir(path.basename(p));
    } else {
      await this.FtpClient.remove(path.basename(p));
    }
  }

  /**
   *
   * Creates directory, recursively
   *
   */
  protected async doMkdir(dir: string): Promise<void> {
    await this._restoreRootDir();
    await this.FtpClient.ensureDir(dir);
  }

  protected async doIsDir(dir: string): Promise<boolean> {
    const stat = await this.stat(dir);
    return stat?.IsDirectory ?? false;
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  protected async doStat(file: string): Promise<IStat> {
    await this._restoreRootDir();
    await this._setWorkingDir(file);

    // LIST <dir> returns the directory's content, not its own entry, so list the parent
    const files = await this.FtpClient.list();
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
  protected async doList(dir: string): Promise<string[]> {
    await this._restoreRootDir();
    await this.FtpClient.cd(path.dirname(dir));
    const files = await this.FtpClient.list(path.basename(dir));
    return files.map((f) => f.name);
  }

  /**
   * Downloads the zip to the local temp fs and extracts it there.
   * Destination fs must be a local-path filesystem ( defaults to the temp fs ) -
   * extracting directly onto the ftp server is not supported.
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
   * Downloads given remote files to the local temp fs and zips them there.
   * Result is created on dstFs ( defaults to the temp fs ). Entry names are the
   * remote paths.
   */
  protected async doZip(sources: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult> {
    const paths = Array.isArray(sources) ? sources : [sources];
    const downloaded: [string, string][] = [];

    try {
      for (const entry of paths) {
        const remote = Array.isArray(entry) ? entry[0] : entry;
        const entryName = Array.isArray(entry) ? entry[1] : entry;
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

  protected async doHash(p: string, algo?: string): Promise<string> {
    const local = await this.download(p);

    try {
      return await DI.resolve<FileHasher>(FileHasher, [algo]).hash(local);
    } finally {
      await this.TempFs.rm(local);
    }
  }

  protected async doMetadata(p: string): Promise<IFileInfo> {
    const local = await this.download(p);

    try {
      return await this.FileInfo.getInfo(local);
    } finally {
      await this.TempFs.rm(local);
    }
  }

  public resolvePath(_path: string): string {
    throw new MethodNotImplemented('fs ftp does not support path resolving');
  }
}
