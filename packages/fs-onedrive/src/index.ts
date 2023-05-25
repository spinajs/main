import { ClientSecretCredential } from "@azure/identity";
import { Client, OneDriveLargeFileUploadOptions, OneDriveLargeFileUploadTask, StreamUpload, UploadEventHandlers, UploadResult } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider, TokenCredentialAuthenticationProviderOptions } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";

import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, IStat, IZipResult } from '@spinajs/fs';
import { Config } from '@spinajs/configuration';
import archiver from 'archiver';
import { basename } from 'path';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { createReadStream, readFileSync } from 'fs';


export interface IOnedriveConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  name: string;
  drive: string;
  debug: boolean;
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
export class fsS3 extends fs {
  @Logger('fs-onedrive')
  protected Logger: ILog;


  @Config('fs.onedrive')
  protected Config: IOnedriveConfig;

  /**
   * File system for temporary files
   */
  protected TempFs: fs;

  protected OneDriveCredentials: ClientSecretCredential;
  protected AuthProvider: TokenCredentialAuthenticationProvider;
  protected Client: Client;

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

    this.OneDriveCredentials = new ClientSecretCredential(this.Options.tenantId, this.Options.clientId, this.Options.clientSecret);
    this.AuthProvider = new TokenCredentialAuthenticationProvider(this.OneDriveCredentials, { scopes: [".default"] });

    this.Client = Client.initWithMiddleware({
      debugLogging: this.Options.debug,
      authProvider: this.AuthProvider,
    });


    this.TempFs = await DI.resolve<Promise<fs>>('__file_provider__', ['fs-temp']);
  }

  /**
   *
   * Tries to download file to local filesystem, then returns local filesystem path.
   * Native implementation simply returns local path and does nothing.
   *
   * @param path - file to download
   */
  public async download(path: string): Promise<string> {
    
  }

  /**
   * read all content of file
   */
  public async read(path: string, encoding: BufferEncoding) {
    const fLocal = await this.download(path);
    const content = await this.TempFs.read(fLocal, encoding);

    await this.TempFs.unlink(fLocal);

    return content;
  }

  public async readStream(path: string, encoding?: BufferEncoding) {
    const fLocal = await this.download(path);
    return this.TempFs.readStream(fLocal, encoding);
  }

  /**
   * Write to file string or buffer
   */
  public async write(path: string, data: string | Buffer, encoding?: BufferEncoding) {
    
    await this.api("/users/8b6fd886-ae7f-4dbc-b778-121ef5e081d1/drive/root:/test/test.zip:/content").putStream(fs.createReadStream("test.zip"));

  }

  public async append(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void> {
    /**
     * We cannot append to file in s3 directly,
     * we have to download file firs, append locally, then upload again new file
     */
    const fLocal = await this.download(path);

    await this.TempFs.append(fLocal, data, encoding);

    const wStream = await this.writeStream(path, encoding);
    const rStream = await this.TempFs.readStream(fLocal, encoding);

    return new Promise((resolve, reject) => {
      rStream
        .pipe(wStream)
        .on('end', () => {
          this.TempFs.rm(fLocal)
            .then(() => {
              return resolve();
            })
            .catch(() => {
              resolve();
            });
        })
        .on('error', (err) => {
          // eslint-disable-next-line promise/no-promise-in-callback
          this.TempFs.rm(fLocal)
            .then(() => {
              return reject(err);
            })
            .catch(() => {
              reject(err);
            });
        });
    });
  }

  public async writeStream(path: string, encoding?: BufferEncoding) {
     
  }

  /**
   * Checks if file existst
   * @param path - path to check
   */
  public async exists(path: string) {
      
  }

  public async dirExists() {
    
  }

  /**
   * Copy file to another location
   * @param path - src path
   * @param dest - dest path
   */
  public async copy(path: string, dest: string) {
     
  }

  /**
   * Copy file to another location and deletes src file
   */
  public async move(oldPath: string, newPath: string) {
   
  }

  /**
   * Change name of a file
   */
  public async rename(oldPath: string, newPath: string) {
  }

  /**
   * Deletes file permanently
   *
   * @param path - path to file that will be deleted
   * @param onlyTemp - remote filesystems need to download file before, if so, calling unlink with this flag removes only local temp file after we finished processing
   */
  public async unlink(path: string, onlyTemp?: boolean) {
    
  }

  /**
   *
   * Deletes dir recursively & all contents inside
   *
   * @param path - dir to remove
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  public async rm(_path: string) {
    // s3 is not deleting folders
  }

  /**
   *
   * Creates directory, recursively
   *
   */
  public async mkdir() {
    // s3 dont need to create folders
  }

  /**
   * Returns file statistics, not all fields may be accesible
   */
  public async stat(path: string): Promise<IStat> {
     
  }

  protected async getSignedUrl(path: string) {
    
  }

  public tmppath(): string {
    throw new MethodNotImplemented('fs s3 does not support temporary paths');
  }

  /**
   * List content of directory
   *
   * @param path - path to directory
   */
  public async list(path: string) {
    
  }

  public async zip(path: string, zName?: string): Promise<IZipResult> {
    const zTmpName = this.TempFs.tmppath();
    const output = await this.TempFs.writeStream(zTmpName);
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Sets the compression level.
    });

    // pipe archive data to the file
    archive.pipe(output);

    const tFile = await this.download(path);
    archive.file(tFile, { name: zName ?? basename(path) });

    await archive.finalize();

    return {
      asFilePath: () => {
        return zTmpName;
      },
      asStream: (encoding?: BufferEncoding) => {
        return createReadStream(`${zTmpName}`, encoding);
      },
      asBase64: () => {
        return readFileSync(`${zTmpName}`, 'base64');
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public resolvePath() {
    throw new MethodNotImplemented('fs s3 does not support path resolving');
  }
}
