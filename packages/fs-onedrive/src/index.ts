import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';

import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, FileSystem, IFsUploadOptions, IStat, IWriteStreamOptions, IZipResult } from '@spinajs/fs';
import { Config } from '@spinajs/configuration';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { PassThrough } from 'stream';

export interface IOnedriveConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  name: string;
  /** Graph drive id. Not read by `fsOneDrive`; reserved for subclasses that build drive paths. */
  drive: string;
  debug: boolean;
}

export interface IOnedriveEndpoints {
  aad_endpoint: string;
  graph_endpoint: string;
}

/**
 * OneDrive filesystem provider.
 *
 * NOTE: this provider is a work in progress. Authentication / client bootstrap
 * is implemented, but the actual file operations are not yet available and will
 * throw `MethodNotImplemented` until finished. It is intentionally explicit so
 * callers get a clear error instead of silent `undefined` results.
 */
@Injectable('fs')
@PerInstanceCheck()
export class fsOneDrive extends fs {
  @Logger('fs-onedrive')
  protected Logger: Log;

  @Config('fs.onedrive')
  protected Config: IOnedriveEndpoints;

  /**
   * File system for temporary files. Resolved lazily, so provider creation order does not matter.
   */
  @FileSystem('fs-temp')
  protected TempFs: fs;

  protected OneDriveCredentials: ClientSecretCredential;
  protected Client: Client;

  /**
   * Graph scope used when requesting access tokens.
   */
  protected static readonly GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

  /**
   * Name of provider. We can have multiple providers of the same type but with different options.
   * Also used in InjectService decorator for mapping
   */
  public get Name(): string {
    return this.Options.name;
  }

  constructor(public Options: IOnedriveConfig) {
    super();
  }

  public async resolve() {
    await super.resolve();

    this.OneDriveCredentials = new ClientSecretCredential(this.Options.tenantId, this.Options.clientId, this.Options.clientSecret, {
      authorityHost: this.Config?.aad_endpoint,
    });

    this.Client = Client.initWithMiddleware({
      debugLogging: this.Options.debug,
      baseUrl: this.Config?.graph_endpoint ? new URL('v1.0', this.Config.graph_endpoint).href : undefined,
      authProvider: {
        getAccessToken: async () => {
          const token = await this.OneDriveCredentials.getToken((this.constructor as typeof fsOneDrive).GRAPH_SCOPE);
          return token?.token ?? '';
        },
      },
    });
  }

  private notImplemented(method: string): never {
    throw new MethodNotImplemented(`fs onedrive provider does not implement '${method}' yet`);
  }

  protected async doDownload(_path: string): Promise<string> {
    return this.notImplemented('download');
  }

  protected async doUpload(_srcPath: string, _destPath: string, _options?: IFsUploadOptions): Promise<void> {
    return this.notImplemented('upload');
  }

  protected async doRead(_path: string, _encoding?: BufferEncoding): Promise<string | Buffer> {
    return this.notImplemented('read');
  }

  protected async doReadStream(_path: string, _encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    return this.notImplemented('readStream');
  }

  protected async doWrite(_path: string, _data: string | Uint8Array, _encoding?: BufferEncoding): Promise<void> {
    return this.notImplemented('write');
  }

  protected async doWriteStream(_path: string, _readStream: NodeJS.ReadableStream | undefined, _options: IWriteStreamOptions): Promise<PassThrough> {
    return this.notImplemented('writeStream');
  }

  protected async doAppend(_path: string, _data: string | Uint8Array, _encoding?: BufferEncoding): Promise<void> {
    return this.notImplemented('append');
  }

  protected async doExists(_path: string): Promise<boolean> {
    return this.notImplemented('exists');
  }

  protected async doDirExists(_path: string): Promise<boolean> {
    return this.notImplemented('dirExists');
  }

  protected async doCopy(_path: string, _dest: string, _dstFs?: fs): Promise<void> {
    return this.notImplemented('copy');
  }

  protected async doMove(_oldPath: string, _newPath: string, _dstFs?: fs): Promise<void> {
    return this.notImplemented('move');
  }

  protected async doRename(_oldPath: string, _newPath: string): Promise<void> {
    return this.notImplemented('rename');
  }

  protected async doRm(_path: string): Promise<void> {
    return this.notImplemented('rm');
  }

  protected async doMkdir(_path: string): Promise<void> {
    return this.notImplemented('mkdir');
  }

  protected async doStat(_path: string): Promise<IStat> {
    return this.notImplemented('stat');
  }

  protected async doIsDir(_path: string): Promise<boolean> {
    return this.notImplemented('isDir');
  }

  protected async doList(_path: string): Promise<string[]> {
    return this.notImplemented('list');
  }

  public tmppath(): string {
    return this.notImplemented('tmppath');
  }

  protected async doZip(_sources: string | (string | string[])[], _dstFs: fs, _dstFile: string): Promise<IZipResult> {
    return this.notImplemented('zip');
  }

  protected async doUnzip(_srcPath: string, _destPath: string, _dstFs: fs): Promise<string> {
    return this.notImplemented('unzip');
  }

  public resolvePath(_path: string): string {
    return this.notImplemented('resolvePath');
  }
}
