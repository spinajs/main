/* eslint-disable security/detect-non-literal-fs-filename */
import { AsyncService, DI, IInstanceCheck, IMappableService } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, IOFail, MethodNotImplemented } from '@spinajs/exceptions';
import { ReadStream, WriteStream } from 'fs';
import { DateTime } from 'luxon';
import { PassThrough } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import type { BinaryToTextEncoding } from 'node:crypto';
import { getFs } from './helpers.js';
import { basename } from 'path';
import { executeFsAction, fsTarget } from './actions.js';
import type { FsTarget, FsTargetSpec } from './actions.js';

/**
 * Class for handling fs URI eg. fs://fs-temp/path/to/file
 */
export class URI {
  public Fs: fs;
  public Path: string;

  constructor(uri: string) {
    // strict scheme - previous pattern /(fs+:\/\/)+/ accepted eg. fsss:// and fs://fs://
    const reg = /^fs:\/\/(.+)$/;
    const e = reg.exec(uri);

    if (!e) {
      throw new InvalidArgument(`URI ${uri} is not valid`);
    }

    const match = e[1];
    const slash = match.indexOf('/');

    // fs://name ( no path ) -> whole match is the fs name, path is empty
    const fsName = slash === -1 ? match : match.substring(0, slash);
    this.Path = slash === -1 ? '' : match.substring(slash + 1);
    this.Fs = getFs(fsName);

    if (!this.Fs) {
      throw new InvalidArgument(`Filesystem ${fsName} not registered, check your fs configuration !`);
    }
  }
}

export interface IProviderConfiguration {
  name: string;
  service: string;

  /**
   * Name of another configured fs provider this one depends on ( eg. fsTemp backend ).
   * fsService creates referenced providers first, regardless of config order.
   */
  provider?: string;
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

  /**
   * Opaque, provider-supplied token that changes when the file content changes.
   * Consumers must treat it as meaningless except for equality comparison.
   * Providers that cannot supply one leave it undefined.
   */
  Version?: string;

  AdditionalData?: unknown;
}

export interface IFileInfo {
  /**
   * Size in bytes
   */

  FileSize: number;
  Height?: number;
  Width?: number;

  Duration?: number;
  FrameCount?: number;
  FrameRate?: number;

  /**
   * Number of audio channels ( eg. 2 for stereo )
   */
  AudioChannels?: number;

  Bitrate?: number;
  Codec?: string;

  LineCount?: number;
  Encoding?: string;
  MimeType?: string;
  WordCount?: number;

  AccessDate?: DateTime;
  ModificationDate?: DateTime;
  CreationDate?: DateTime;

  /**
   * Raw unprocessed data obtained from file info
   */
  Raw?: {};

  /**
   * All other extracted tags are promoted here generically ( PascalCased tag
   * name -> value ). The well-known fields above are typed aliases over the
   * same data; everything the analyzer emits is also available in {@link Raw}.
   */
  [key: string]: unknown;
}

export interface IFsLocalOptions {
  /**
   * Full path to local directory where files are hold.
   * All paths will be relative to this directory
   *
   * If path is not provided, it will behave like normal nodejs fs functions
   */
  basePath?: string;

  /**
   * Instance name of this filesystem. Used to share fs instances.
   */
  name: string;
}

export interface ITempOptions {
  /**
   * Should cleanup of old temp files be enabled
   */
  cleanup?: boolean;

  /**
   * Cleanup interval in milliseconds, used by interval-based cleanup strategies.
   * Default is 10 minutes
   */
  cleanupInterval?: number;

  /**
   * Max temp file age in seconds. Older than this will be deleted.
   * Default is 1 hour
   */
  maxFileAge?: number;

  /**
   * Class name of TempCleanupStrategy implementation to use.
   * Default is MaxAgeTempCleanupStrategy
   */
  cleanupStrategy?: string;

  /**
   * Cron expression used by CronTempCleanupStrategy ( 6-field with seconds supported,
   * eg. '0 0 * * * *' = hourly ). Required when that strategy is selected.
   * Ignored by interval-based strategies.
   */
  cleanupCronExpression?: string;
}

export interface IFsTempOptions extends ITempOptions {
  /**
   * Instance name of this filesystem. Used to share fs instances.
   */
  name: string;

  /**
   * Name of registered fs provider used as temp file storage.
   * Any configured fs can serve as backend ( local, s3, ftp, ... ).
   * Creation fails if provider with this name is not registered.
   */
  provider: string;
}

export interface IZipResult {
  /**
   * Destination filesystem ( default is fs-temp for zipped files)
   */
  fs: fs;

  // return file path to zipped file
  asFilePath(): string;

  // return as stream to zipped content
  asStream(encoding?: BufferEncoding): ReadStream;

  // return base64 representation of zipped content
  asBase64(): string;

  // deletes zipped  file ( from temp filesystem )
  unlink(): Promise<void>;
}

export interface IFsUploadOptions {
  /**
   * Fail with `ResourceDuplicated` instead of overwriting when `destPath` already exists.
   * Providers do it atomically where the backend allows ( see each provider's docs ).
   */
  exclusive?: boolean;
}

const FS_ACTION_METHODS = [
  'download', 'upload', 'hash', 'metadata', 'read', 'readStream', 'write', 'writeStream', 'append',
  'exists', 'dirExists', 'stat', 'isDir', 'list', 'mkdir', 'rm', 'copy', 'move', 'rename', 'zip', 'unzip',
  'signedUrl', 'getSignedUrl',
] as const;

const checkedClasses = new WeakSet<object>();

// A subclass overriding a public action would skip normalisation and every middleware.
function assertNoActionOverrides(instance: object, base: object): void {
  const proto = Object.getPrototypeOf(instance) as object;
  if (checkedClasses.has(proto)) return;
  for (let p: object | null = proto; p && p !== base; p = Object.getPrototypeOf(p) as object | null) {
    for (const name of FS_ACTION_METHODS) {
      if (Object.hasOwn(p, name)) {
        const hook = `do${name[0].toUpperCase()}${name.slice(1)}`;
        throw new InvalidOperation(`${(p as { constructor: { name: string } }).constructor.name} overrides ${name}; implement ${hook} instead`);
      }
    }
  }
  checkedClasses.add(proto);
}

export abstract class fs extends AsyncService implements IMappableService, IInstanceCheck {
  constructor() {
    super();
    assertNoActionOverrides(this, fs.prototype);
  }

  public get ServiceName() {
    return this.Name;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public __checkInstance__(creationOptions: any): boolean {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return this.Name === creationOptions[0].name;
  }

  public abstract Name: string;

  /** Root that absolute paths are made relative to before any action; undefined when the provider has none. */
  public get BasePath(): string | undefined {
    return undefined;
  }

  /**
   * Downloads file to local storage and returns path to it.
   * On local providers it only returns the full path; remote providers download to local disk first.
   */
  public download(path: string): Promise<string> {
    return this.runAction('download', [{ path, kind: 'file', access: ['read'] }], [], ([t]) => this.doDownload(t.path));
  }

  /**
   * Copies local file into fs
   *
   * @param srcPath source path ( full absolute path eg. file from local disk; not checked )
   * @param destPath dest path ( relative to base path of provider ), default the source file name
   * @param options.exclusive throw ResourceDuplicated instead of overwriting an existing destination
   */
  public upload(srcPath: string, destPath?: string, options?: IFsUploadOptions): Promise<void> {
    return this.runAction(
      'upload',
      [{ path: destPath ?? basename(srcPath), kind: 'file', access: ['write'], role: 'destination' }],
      [srcPath, options],
      ([t], [src, o]) => this.doUpload(src as string, t.path, o as IFsUploadOptions | undefined),
    );
  }

  /**
   * Returns hash of file
   *
   * @param algo optional hash alghoritm, default is `fs.hasher.defaultAlgorithm`, then sha256
   */
  public hash(path: string, algo?: string): Promise<string> {
    return this.runAction('hash', [{ path, kind: 'file', access: ['read'] }], [algo], ([t], [a]) => this.doHash(t.path, a as string | undefined));
  }

  public metadata(path: string): Promise<IFileInfo> {
    return this.runAction('metadata', [{ path, kind: 'file', access: ['read'] }], [], ([t]) => this.doMetadata(t.path));
  }

  /**
   * Returns full LOCAL path to file
   */
  public abstract resolvePath(path: string): string;

  public read(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    return this.runAction('read', [{ path, kind: 'file', access: ['read'] }], [encoding], ([t], [e]) => this.doRead(t.path, e as BufferEncoding | undefined));
  }

  public readStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    return this.runAction('readStream', [{ path, kind: 'file', access: ['read'] }], [encoding], ([t], [e]) => this.doReadStream(t.path, e as BufferEncoding | undefined));
  }

  public write(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return this.runAction('write', [{ path, kind: 'file', access: ['write'] }], [data, encoding], ([t], [d, e]) => this.doWrite(t.path, d as string | Uint8Array, e as BufferEncoding | undefined));
  }

  public writeStream(path: string, encoding?: BufferEncoding): Promise<WriteStream | PassThrough>;
  public writeStream(path: string, readStream: NodeJS.ReadableStream | BufferEncoding, encoding?: BufferEncoding): Promise<WriteStream | PassThrough>;
  public writeStream(path: string, readStream?: NodeJS.ReadableStream | BufferEncoding, encoding?: BufferEncoding): Promise<WriteStream | PassThrough> {
    return this.runAction(
      'writeStream',
      [{ path, kind: 'file', access: ['write'] }],
      [readStream, encoding],
      ([t], [r, e]) => this.doWriteStream(t.path, r as NodeJS.ReadableStream | BufferEncoding | undefined, e as BufferEncoding | undefined),
      { stream: true },
    );
  }

  public append(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return this.runAction('append', [{ path, kind: 'file', access: ['write'] }], [data, encoding], ([t], [d, e]) => this.doAppend(t.path, d as string | Uint8Array, e as BufferEncoding | undefined));
  }

  public exists(path: string): Promise<boolean> {
    return this.runAction('exists', [{ path, kind: 'file', access: ['stat'] }], [], ([t]) => this.doExists(t.path));
  }

  public dirExists(path: string): Promise<boolean> {
    return this.runAction('dirExists', [{ path, kind: 'dir', access: ['stat'] }], [], ([t]) => this.doDirExists(t.path));
  }

  public stat(path: string): Promise<IStat> {
    return this.runAction('stat', [{ path, kind: 'file', access: ['stat'] }], [], ([t]) => this.doStat(t.path));
  }

  public isDir(path: string): Promise<boolean> {
    return this.runAction('isDir', [{ path, kind: 'dir', access: ['stat'] }], [], ([t]) => this.doIsDir(t.path));
  }

  public list(path: string): Promise<string[]> {
    return this.runAction('list', [{ path, kind: 'dir', access: ['list'] }], [], ([t]) => this.doList(t.path));
  }

  public mkdir(path: string): Promise<void> {
    return this.runAction('mkdir', [{ path, kind: 'dir', access: ['write'] }], [], ([t]) => this.doMkdir(t.path));
  }

  public rm(path: string): Promise<void> {
    return this.runAction('rm', [{ path, kind: 'file', access: ['delete'] }], [], ([t]) => this.doRm(t.path));
  }

  public copy(path: string, dest: string, dstFs?: fs): Promise<void> {
    return this.runAction(
      'copy',
      [
        { path, kind: 'file', access: ['read'] },
        { fs: dstFs ?? this, path: dest, kind: 'file', access: ['write'], role: 'destination' },
      ],
      [],
      ([s, d]) => this.doCopy(s.path, d.path, dstFs),
    );
  }

  public move(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    return this.runAction(
      'move',
      [
        { path: oldPath, kind: 'file', access: ['read', 'delete'] },
        { fs: dstFs ?? this, path: newPath, kind: 'file', access: ['write'], role: 'destination' },
      ],
      [],
      ([s, d]) => this.doMove(s.path, d.path, dstFs),
    );
  }

  public rename(oldPath: string, newPath: string): Promise<void> {
    return this.runAction(
      'rename',
      [
        { path: oldPath, kind: 'file', access: ['read', 'delete'] },
        { path: newPath, kind: 'file', access: ['write'], role: 'destination' },
      ],
      [],
      ([s, d]) => this.doRename(s.path, d.path),
    );
  }

  /**
   * Compress specified file or dir in provided path. Dir is compressed recursively.
   * An entry `[path, entryName]` names the entry in the archive.
   */
  public zip(path: string | (string | string[])[], dstFs?: fs, dstFile?: string): Promise<IZipResult> {
    const sources = Array.isArray(path) ? path : [path];
    const dst = dstFs ?? this.zipDestination();
    const specs: FsTargetSpec[] = sources.map((s) => ({ path: Array.isArray(s) ? s[0] : s, kind: 'file' as const, access: ['read' as const] }));
    specs.push({ fs: dst, path: dstFile ?? dst.tmpname('.zip'), kind: 'file', access: ['write'], role: 'destination' });
    return this.runAction('zip', specs, [], (targets) => {
      const normalised = sources.map((s, i) => (Array.isArray(s) ? [targets[i].path, ...s.slice(1)] : targets[i].path));
      return this.doZip(Array.isArray(path) ? normalised : (normalised[0] as string), dst, targets[targets.length - 1].path);
    });
  }

  /**
   * Decompress given file to destination dir, default a temp name on the destination fs.
   *
   * @returns path to unzipped file
   */
  public unzip(srcPath: string, destPath?: string, dstFs?: fs): Promise<string> {
    const dst = dstFs ?? this.unzipDestination();
    return this.runAction(
      'unzip',
      [
        { path: srcPath, kind: 'file', access: ['read'] },
        { fs: dst, path: destPath ?? dst.tmpname(), kind: 'dir', access: ['write'], role: 'destination' },
      ],
      [],
      ([s, d]) => this.doUnzip(s.path, d.path, dst),
    );
  }

  /**
   * Returns a time-limited public URL to the file.
   *
   * @param opts.until when the URL expires ( provider default when absent )
   * @param opts.disposition content disposition the URL should serve the file with
   * @throws MethodNotImplemented when the provider has no public URLs
   */
  public signedUrl(path: string, opts: { until?: DateTime; disposition?: string } = {}): Promise<string> {
    return this.runAction('signedUrl', [{ path, kind: 'file', access: ['share'] }], [opts], ([t], [o]) => {
      if (!this.doSignedUrl) throw new MethodNotImplemented(`${this.Name} does not create signed URLs`);
      return this.doSignedUrl(t.path, (o ?? {}) as { until?: DateTime; disposition?: string });
    });
  }

  public getSignedUrl(path: string, until?: DateTime): Promise<string> {
    return this.signedUrl(path, until ? { until } : {});
  }

  public abstract tmppath(ext?: string): string;

  public tmpname(ext?: string) {
    return ext ? `${uuidv4()}${ext}` : uuidv4();
  }

  /** Where zip writes when the caller names no destination fs. */
  protected zipDestination(): fs {
    return this;
  }

  /** Where unzip writes when the caller names no destination fs. */
  protected unzipDestination(): fs {
    return this;
  }

  /** Every file action goes through here; provider methods that touch files outside the public API use it too. */
  protected runAction<R>(
    action: string,
    targets: readonly FsTargetSpec[],
    args: unknown[],
    impl: (targets: readonly FsTarget[], args: unknown[]) => Promise<R>,
    opts: { stream?: boolean } = {},
  ): Promise<R> {
    let resolved: FsTarget[];
    try {
      resolved = targets.map((t) => fsTarget(this, t));
    } catch (err) {
      return Promise.reject(err);
    }
    return executeFsAction({ action, owner: this, targets: resolved, args, impl, stream: opts.stream === true });
  }

  protected doHash(path: string, algo?: string): Promise<string> {
    const hasher = DI.resolve<FileHasher>(FileHasher, [algo]);
    return hasher.hash(this.resolvePath(path));
  }

  protected doMetadata(path: string): Promise<IFileInfo> {
    const fInfo = DI.resolve<FileInfoService>(FileInfoService);
    return fInfo.getInfo(this.resolvePath(path));
  }

  protected abstract doDownload(path: string): Promise<string>;
  /** `options.exclusive`: throw ResourceDuplicated when `destPath` exists, atomically where the backend allows. */
  protected abstract doUpload(srcPath: string, destPath: string, options?: IFsUploadOptions): Promise<void>;
  protected abstract doRead(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  protected abstract doReadStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream>;
  protected abstract doWrite(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  protected abstract doWriteStream(path: string, readStream?: NodeJS.ReadableStream | BufferEncoding, encoding?: BufferEncoding): Promise<WriteStream | PassThrough>;
  protected abstract doAppend(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  protected abstract doExists(path: string): Promise<boolean>;
  protected abstract doDirExists(path: string): Promise<boolean>;
  protected abstract doStat(path: string): Promise<IStat>;
  protected abstract doIsDir(path: string): Promise<boolean>;
  protected abstract doList(path: string): Promise<string[]>;
  protected abstract doMkdir(path: string): Promise<void>;
  protected abstract doRm(path: string): Promise<void>;
  /** `dstFs` as the caller passed it; undefined copies within this fs. */
  protected abstract doCopy(path: string, dest: string, dstFs?: fs): Promise<void>;
  protected abstract doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void>;
  protected abstract doRename(oldPath: string, newPath: string): Promise<void>;
  /** `dstFs` and `dstFile` are resolved by the base class: the destination that was checked. */
  protected abstract doZip(path: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult>;
  protected abstract doUnzip(srcPath: string, destPath: string, dstFs: fs): Promise<string>;
  protected doSignedUrl?(path: string, opts: { until?: DateTime; disposition?: string }): Promise<string>;

  /**
   * -------------------------------------------------------------------------
   *
   * STATIC METHODS
   *
   * -------------------------------------------------------------------------
   */

  /**
   * Downloads file to local storage and returns path to it.
   * If used on local storage provider eg. hard drive it only returns full path to file
   *
   * On remote storage provivers eg. amazon s3 - it tries to download it to local disk first and returns
   * full path.
   *
   * Returns local path to file
   *
   * @param path path to download
   */
  public static download(path: URI): Promise<string> {
    return path.Fs.download(path.Path);
  }

  /**
   * Copies local file into fs
   *
   * @param srcPath source path ( full absolute path eg. file from local disk )
   * @param destPath dest path ( relative to base path of provider )
   */
  public static upload(srcPath: string, destPath?: URI): Promise<void> {
    return destPath!.Fs.upload(srcPath, destPath!.Path);
  }

  /**
   *
   * Returns hash of file
   *
   * @param srcPath file to calculate hash
   * @param algo optional hash alghoritm, default is `fs.hasher.defaultAlgorithm`, then sha256
   */
  public static hash(path: URI, algo?: string): Promise<string> {
    return path.Fs.hash(path.Path, algo);
  }

  /**
   *
   * Returns full LOCAL path to file
   *
   * @param path path to resolve
   */
  public static resolvePath(path: URI): string {
    return path.Fs.resolvePath(path.Path);
  }

  public static read(path: URI, encoding?: BufferEncoding): Promise<string | Buffer> {
    return path.Fs.read(path.Path, encoding);
  }

  public static readStream(path: URI, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    return path.Fs.readStream(path.Path, encoding);
  }

  public static write(path: URI, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return path.Fs.write(path.Path, data, encoding);
  }

  public static writeStream(path: URI, encoding: BufferEncoding): Promise<WriteStream | PassThrough>;
  public static writeStream(path: URI, readStream: NodeJS.ReadableStream | BufferEncoding, encoding?: BufferEncoding): Promise<WriteStream | PassThrough>;
  public static writeStream(
    path: URI,
    readStream: NodeJS.ReadableStream | BufferEncoding,
    encoding?: BufferEncoding,
  ): Promise<WriteStream | PassThrough> {
    return path.Fs.writeStream(path.Path, readStream, encoding);
  }

  public static exists(path: URI): Promise<boolean> {
    return path.Fs.exists(path.Path);
  }

  public static dirExists(path: URI): Promise<boolean> {
    return path.Fs.dirExists(path.Path);
  }

  public static copy(src: URI, dest: URI): Promise<void> {
    return src.Fs.copy(src.Path, dest.Path, dest.Fs);
  }

  public static move(src: URI, dest: URI): Promise<void> {
    return src.Fs.move(src.Path, dest.Path, dest.Fs);
  }

  public static rename(src: URI, dest: URI | string): Promise<void> {
    return src.Fs.rename(src.Path, dest instanceof URI ? dest.Path : dest);
  }
  public static rm(path: URI): Promise<void> {
    return path.Fs.rm(path.Path);
  }

  public static mkdir(path: URI): Promise<void> {
    return path.Fs.mkdir(path.Path);
  }

  public static stat(path: URI): Promise<IStat> {
    return path.Fs.stat(path.Path);
  }

  public static list(path: URI): Promise<string[]> {
    return path.Fs.list(path.Path);
  }

  public static tmppath(fs: string, ext?: string): string {
    const f = getFs(fs);
    if (!f) {
      throw new IOFail(`Filesystem ${fs} not exists, check your configuration`);
    }

    return f.tmppath(ext);
  }

  public static append(path: URI, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    return path.Fs.append(path.Path, data, encoding);
  }
  /**
   *
   * Compress specified file or dir in provided path.
   * Dir is compressed recursively
   *
   * @param path - path to zip
   * @param dstFile - destination file name
   */
  public static zip(path: URI | URI[], dstFile: URI): Promise<IZipResult> {
    const fs = !Array.isArray(path) ? path.Fs : path[0].Fs;
    const files = Array.isArray(path) ? path.map((x) => x.Path) : path.Path;
    return fs.zip(files, dstFile.Fs, dstFile.Path);
  }

  /**
   * Decompress given file to destination path
   *
   * @param path path to zip file
   * @param destPath path to destination dir
   *
   * @returns path to unzipped file
   */
  public static unzip(srcPath: URI, destPath: URI): Promise<string> {
    return srcPath.Fs.unzip(srcPath.Path, destPath.Path, destPath.Fs);
  }

  /**
   *
   * Checks if given path is dir
   *
   * @param path path to check
   */
  public static isDir(path: URI): Promise<boolean> {
    return path.Fs.isDir(path.Path);
  }
}

/**
 * Wraps every configured fs provider. fsService first publishes every raw provider, so
 * providers that look up a backend by name in their own resolve() get the raw one, then
 * replaces each entry with the result of the decorators, run in ascending `order`.
 * When a decorator throws, every provider is unpublished and fsService fails to resolve.
 */
export abstract class FsDecorator {
  abstract readonly order: number;
  abstract decorate(instance: fs, config: IProviderConfiguration): fs;
}

/**
 * File information service, obtain file props, metadata etc.
 * Eg. movie resolution, image, codec etc. if possible
 */
export abstract class FileInfoService {
  /**
   * Extracts file information from a file on disk.
   *
   * @param pathToFile absolute path to the file
   */
  public abstract getInfo(pathToFile: string): Promise<IFileInfo>;

  /**
   * Extracts file information from a readable stream ( content is fed to the
   * analyzer via stdin, so no temporary file is needed ).
   *
   * @param stream readable stream with the file content
   */
  public abstract getInfoFromStream(stream: NodeJS.ReadableStream): Promise<IFileInfo>;
}

/**
 * File hasher, to create unique hash for a file, raw data or a stream.
 */
export abstract class FileHasher {
  /**
   * Hashes the content of a file.
   *
   * @param pathToFile absolute path to the file
   * @param encoding digest output encoding ( default 'hex' )
   */
  public abstract hash(pathToFile: string, encoding?: BinaryToTextEncoding): Promise<string>;

  /**
   * Hashes raw in-memory data.
   *
   * @param data string or Buffer to hash
   * @param encoding digest output encoding ( default 'hex' )
   */
  public abstract hashData(data: string | Uint8Array, encoding?: BinaryToTextEncoding): Promise<string>;

  /**
   * Hashes the content of a readable stream.
   *
   * @param stream readable stream to consume
   * @param encoding digest output encoding ( default 'hex' )
   */
  public abstract hashStream(stream: NodeJS.ReadableStream, encoding?: BinaryToTextEncoding): Promise<string>;
}
