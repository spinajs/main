import { IOFail } from '@spinajs/exceptions';
import { DI, Injectable, PerInstanceCheck, ResolveException } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { WriteStream } from 'fs';
import { PassThrough } from 'stream';
import { fs, IFsTempOptions, IFsUploadOptions, IStat, IZipResult } from './interfaces.js';
import { MaxAgeTempCleanupStrategy, TempCleanupStrategy } from './temp-cleanup-strategy.js';
import { getFs } from './helpers.js';

/**
 * Temp filesystem. Use it for creating and storing temporary files and dirs.
 *
 * It is a wrapper over any other registered fs provider - all file operations are
 * delegated to backend fs selected by `provider` option, so temp files can live
 * on local disk, s3, ftp etc. Backend must be a registered fs provider - creation
 * fails otherwise.
 *
 * Old files are automatically deleted by configured TempCleanupStrategy
 * ( default: first level files older than `maxFileAge` seconds ).
 */
@Injectable('fs')
@PerInstanceCheck()
export class fsTemp extends fs {
  @Logger('fs')
  protected Logger: Log;

  /**
   * Backend filesystem holding temp files. Registered and disposed
   * independently - this wrapper does not own it.
   */
  protected Provider: fs;

  /**
   * Cleanup policy, selectable via `cleanupStrategy` option.
   * Owns its own schedule ( interval, cron, ... ) via start / stop.
   */
  protected CleanupStrategy: TempCleanupStrategy;

  public get Name(): string {
    return this.Options.name;
  }

  constructor(public Options: IFsTempOptions) {
    super();

    if (!this.Options) {
      throw new IOFail('Options for fs provider not provided, cannot create fs provider instance');
    }
  }

  public async resolve() {
    await super.resolve();

    if (!this.Options.provider) {
      throw new ResolveException(
        `Temp filesystem ${this.Options.name} has no backend fs configured, set 'provider' option to name of registered fs provider`,
      );
    }

    if (this.Options.provider === this.Options.name) {
      throw new ResolveException(`Temp filesystem ${this.Options.name} cannot use itself as backend fs`);
    }

    // throws ResolveException when backend fs is not registered
    this.Provider = getFs(this.Options.provider);

    const strategies = DI.RootContainer.Registry.getTypes(TempCleanupStrategy);
    const strategyName = this.Options.cleanupStrategy ?? MaxAgeTempCleanupStrategy.name;
    const strategyType = strategies.find((x) => x.name === strategyName);

    if (!strategyType) {
      throw new ResolveException(
        `Temp cleanup strategy ${strategyName} not registered, make sure it is imported and registered in DI container`,
      );
    }

    this.CleanupStrategy = await DI.resolve<TempCleanupStrategy>(strategyType);

    if (!this.Options.cleanup) {
      this.Logger.info(
        { fsName: this.Options.name },
        'Cleanup for temporary files system ${fsName} set to false. Check configuration file if you want to automatically clenaup temporary files.',
      );
      return;
    }

    this.Logger.info(
      {
        fsName: this.Options.name,
        backend: this.Options.provider,
        strategy: strategyName,
        interval: this.Options.cleanupInterval,
        cron: this.Options.cleanupCronExpression,
        maxFileAge: this.Options.maxFileAge,
      },
      'Starting cleanup for temporary files system ${fsName}, backend: ${backend}, strategy: ${strategy}, interval: ${interval}, cron: ${cron}, max file age: ${maxFileAge}',
    );

    this.CleanupStrategy.start(this.Provider, this.Options);
  }

  public async dispose(): Promise<void> {
    // backend fs is a separately registered provider - do not dispose it here
    this.CleanupStrategy?.stop();
  }

  public get BasePath(): string | undefined {
    return this.Provider?.BasePath;
  }

  protected doDownload(path: string): Promise<string> {
    return this.Provider.download(path);
  }

  protected doUpload(srcPath: string, destPath: string, options?: IFsUploadOptions): Promise<void> {
    return this.Provider.upload(srcPath, destPath, options);
  }

  protected doHash(path: string, algo?: string): Promise<string> {
    return this.Provider.hash(path, algo);
  }

  protected doMetadata(path: string) {
    return this.Provider.metadata(path);
  }

  public resolvePath(path: string): string {
    return this.Provider.resolvePath(path);
  }

  protected doRead(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    return this.Provider.read(path, encoding);
  }

  protected doReadStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    return this.Provider.readStream(path, encoding);
  }

  protected doWrite(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return this.Provider.write(path, data, encoding);
  }

  protected doWriteStream(path: string, rStream?: BufferEncoding | NodeJS.ReadableStream, encoding?: BufferEncoding): Promise<WriteStream | PassThrough> {
    return this.Provider.writeStream(path, rStream as NodeJS.ReadableStream | BufferEncoding, encoding);
  }

  protected doExists(path: string): Promise<boolean> {
    return this.Provider.exists(path);
  }

  protected doDirExists(path: string): Promise<boolean> {
    return this.Provider.dirExists(path);
  }

  protected doCopy(path: string, dest: string, dstFs?: fs): Promise<void> {
    return this.Provider.copy(path, dest, dstFs);
  }

  protected doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    return this.Provider.move(oldPath, newPath, dstFs);
  }

  protected doRename(oldPath: string, newPath: string): Promise<void> {
    return this.Provider.rename(oldPath, newPath);
  }

  protected doRm(path: string): Promise<void> {
    return this.Provider.rm(path);
  }

  protected doMkdir(path: string): Promise<void> {
    return this.Provider.mkdir(path);
  }

  protected doStat(path: string): Promise<IStat> {
    return this.Provider.stat(path);
  }

  protected doList(path: string): Promise<string[]> {
    return this.Provider.list(path);
  }

  // `ext` must be forwarded: callers such as fsS3.download() pass extname(path) so the
  // downloaded copy keeps its extension, and consumers pick behaviour from it (templates
  // resolve their renderer by extension). Swallowing it here fails far from the cause.
  public tmppath(ext?: string): string {
    return this.Provider.tmppath(ext);
  }

  protected doAppend(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return this.Provider.append(path, data, encoding);
  }

  // The base class defaults the destination to this temp fs (zipDestination), not the backend, so
  // IZipResult.fs names the temp fs.
  protected doZip(path: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult> {
    return this.Provider.zip(path, dstFs, dstFile);
  }

  protected doUnzip(srcPath: string, destPath: string, dstFs: fs): Promise<string> {
    return this.Provider.unzip(srcPath, destPath, dstFs);
  }

  protected doIsDir(path: string): Promise<boolean> {
    return this.Provider.isDir(path);
  }
}
