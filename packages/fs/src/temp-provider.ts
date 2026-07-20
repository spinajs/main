import { IOFail } from '@spinajs/exceptions';
import { DI, Injectable, PerInstanceCheck, ResolveException } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { WriteStream } from 'fs';
import { PassThrough } from 'stream';
import { fs, IFsTempOptions, IStat, IZipResult } from './interfaces.js';
import { MaxAgeTempCleanupStrategy, TempCleanupStrategy } from './temp-cleanup-strategy.js';

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
    this.Provider = DI.resolve<fs>('__file_provider__', [this.Options.provider]);

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
        `Cleanup for temporary files system ${this.Options.name} set to false. Check configuration file if you want to automatically clenaup temporary files.`,
      );
      return;
    }

    this.Logger.info(
      `Starting cleanup for temporary files system ${this.Options.name}, backend: ${this.Options.provider}, strategy: ${strategyName}, interval: ${this.Options.cleanupInterval}, cron: ${this.Options.cleanupCronExpression}, max file age: ${this.Options.maxFileAge}`,
    );

    this.CleanupStrategy.start(this.Provider, this.Options);
  }

  public async dispose(): Promise<void> {
    // backend fs is a separately registered provider - do not dispose it here
    this.CleanupStrategy?.stop();
  }

  public download(path: string): Promise<string> {
    return this.Provider.download(path);
  }

  public upload(srcPath: string, destPath?: string): Promise<void> {
    return this.Provider.upload(srcPath, destPath);
  }

  public async hash(path: string, algo?: string): Promise<string> {
    return this.Provider.hash(path, algo);
  }

  public async metadata(path: string) {
    return this.Provider.metadata(path);
  }

  public resolvePath(path: string): string {
    return this.Provider.resolvePath(path);
  }

  public read(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    return this.Provider.read(path, encoding);
  }

  public readStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    return this.Provider.readStream(path, encoding);
  }

  public write(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return this.Provider.write(path, data, encoding);
  }

  public writeStream(path: string, encoding?: BufferEncoding): Promise<WriteStream | PassThrough>;
  public writeStream(
    path: string,
    readStream: NodeJS.ReadableStream | BufferEncoding,
    encoding?: BufferEncoding,
  ): Promise<WriteStream | PassThrough>;
  public writeStream(
    path: string,
    rStream?: BufferEncoding | NodeJS.ReadableStream,
    encoding?: BufferEncoding,
  ): Promise<WriteStream | PassThrough> {
    return this.Provider.writeStream(path, rStream as NodeJS.ReadableStream | BufferEncoding, encoding);
  }

  public exists(path: string): Promise<boolean> {
    return this.Provider.exists(path);
  }

  public dirExists(path: string): Promise<boolean> {
    return this.Provider.dirExists(path);
  }

  public copy(path: string, dest: string, dstFs?: fs): Promise<void> {
    return this.Provider.copy(path, dest, dstFs);
  }

  public move(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    return this.Provider.move(oldPath, newPath, dstFs);
  }

  public rename(oldPath: string, newPath: string): Promise<void> {
    return this.Provider.rename(oldPath, newPath);
  }

  public rm(path: string): Promise<void> {
    return this.Provider.rm(path);
  }

  public mkdir(path: string): Promise<void> {
    return this.Provider.mkdir(path);
  }

  public stat(path: string): Promise<IStat> {
    return this.Provider.stat(path);
  }

  public list(path: string): Promise<string[]> {
    return this.Provider.list(path);
  }

  public tmppath(): string {
    return this.Provider.tmppath();
  }

  public append(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return this.Provider.append(path, data, encoding);
  }

  public zip(path: string | (string | string[])[], dstFs?: fs, dstFile?: string): Promise<IZipResult> {
    // default archive destination to this temp fs, not the backend - keeps
    // IZipResult.fs pointing at temp fs name and avoids hardcoded 'fs-temp' fallback
    return this.Provider.zip(path, dstFs ?? this, dstFile);
  }

  public unzip(srcPath: string, destPath?: string, dstFs?: fs): Promise<string> {
    return this.Provider.unzip(srcPath, destPath, dstFs ?? this);
  }

  public isDir(path: string): Promise<boolean> {
    return this.Provider.isDir(path);
  }
}
