import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';

import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, IStat, IZipResult } from '@spinajs/fs';
import { Config } from '@spinajs/configuration';
import { MethodNotImplemented } from '@spinajs/exceptions';

export interface IOnedriveConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  name: string;
  drive: string;
  debug: boolean;
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
  protected Config: IOnedriveConfig;

  /**
   * File system for temporary files
   */
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

    this.OneDriveCredentials = new ClientSecretCredential(this.Options.tenantId, this.Options.clientId, this.Options.clientSecret);

    this.Client = Client.initWithMiddleware({
      debugLogging: this.Options.debug,
      authProvider: {
        getAccessToken: async () => {
          const token = await this.OneDriveCredentials.getToken(fsOneDrive.GRAPH_SCOPE);
          return token?.token ?? '';
        },
      },
    });

    this.TempFs = await DI.resolve<Promise<fs>>('__file_provider__', ['fs-temp']);
  }

  private notImplemented(method: string): never {
    throw new MethodNotImplemented(`fs onedrive provider does not implement '${method}' yet`);
  }

  public async download(_path: string): Promise<string> {
    return this.notImplemented('download');
  }

  public async upload(_srcPath: string, _destPath?: string): Promise<void> {
    return this.notImplemented('upload');
  }

  public async read(_path: string, _encoding?: BufferEncoding): Promise<string | Buffer> {
    return this.notImplemented('read');
  }

  public async readStream(_path: string, _encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    return this.notImplemented('readStream');
  }

  public async write(_path: string, _data: string | Uint8Array, _encoding?: BufferEncoding): Promise<void> {
    return this.notImplemented('write');
  }

  public async writeStream(_path: string, _rStream?: BufferEncoding | NodeJS.ReadableStream, _encoding?: BufferEncoding): Promise<any> {
    return this.notImplemented('writeStream');
  }

  public async append(_path: string, _data: string | Uint8Array, _encoding?: BufferEncoding): Promise<void> {
    return this.notImplemented('append');
  }

  public async exists(_path: string): Promise<boolean> {
    return this.notImplemented('exists');
  }

  public async dirExists(_path: string): Promise<boolean> {
    return this.notImplemented('dirExists');
  }

  public async copy(_path: string, _dest: string, _dstFs?: fs): Promise<void> {
    return this.notImplemented('copy');
  }

  public async move(_oldPath: string, _newPath: string, _dstFs?: fs): Promise<void> {
    return this.notImplemented('move');
  }

  public async rename(_oldPath: string, _newPath: string): Promise<void> {
    return this.notImplemented('rename');
  }

  public async rm(_path: string): Promise<void> {
    return this.notImplemented('rm');
  }

  public async mkdir(_path: string): Promise<void> {
    return this.notImplemented('mkdir');
  }

  public async stat(_path: string): Promise<IStat> {
    return this.notImplemented('stat');
  }

  public async isDir(_path: string): Promise<boolean> {
    return this.notImplemented('isDir');
  }

  public async list(_path: string): Promise<string[]> {
    return this.notImplemented('list');
  }

  public tmppath(): string {
    return this.notImplemented('tmppath');
  }

  public async zip(_path: string | (string | string[])[], _dstFs?: fs, _dstFile?: string): Promise<IZipResult> {
    return this.notImplemented('zip');
  }

  public async unzip(_srcPath: string, _destPath?: string, _dstFs?: fs): Promise<string> {
    return this.notImplemented('unzip');
  }

  public resolvePath(_path: string): string {
    return this.notImplemented('resolvePath');
  }
}
