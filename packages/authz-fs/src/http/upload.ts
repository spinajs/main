import { currentPrincipal, engineLog } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { FileUploadMiddleware } from '@spinajs/http';
import type { IUploadOptions, IUploadedFile } from '@spinajs/http';

import { fsAccessConfig } from '../config/index.js';
import { basePathOf, decideFs, domainService, publishedFs, refOf } from '../guard/shared.js';
import type { FsGuardLog, FsGuardService } from '../guard/shared.js';
import { fsRowOf, normalizeFsPath } from '../refs/index.js';

/** The filesystem `FromFile` uploads to when the route names none. */
export const DEFAULT_UPLOAD_FS = '__file_upload_default_provider__';

export interface AuthzUploadMiddlewareOptions {
  /** Where the Configuration, the published providers and AuthzDomains are resolved; default the root. */
  readonly container?: IContainer;
  /** The service that decides for a domain; default `AuthzDomains.service(domain)`. */
  readonly service?: (domain: string) => Promise<FsGuardService>;
  /** Default: the ALS principal, else UNATTENDED (what AuthzService.current() returns). */
  readonly principal?: () => Principal;
  readonly log?: FsGuardLog;
}

/**
 * Checks `fs:write` on the file an upload will be written to (`options.fs`, else the default upload filesystem,
 * at `file.BaseName`) before the uploader copies it, with that filesystem's mode and domain (design §13): enforce
 * refuses with AccessDenied (403) so the formidable temp file is never copied, audit warns, off does nothing. The
 * guarded copy checks the destination again; this gives the early answer. Apps add it to `http.upload.middlewares`,
 * last, after middlewares that rename the file.
 */
@Injectable(FileUploadMiddleware)
export class AuthzUploadMiddleware extends FileUploadMiddleware {
  constructor(protected readonly options: AuthzUploadMiddlewareOptions = {}) {
    super();
  }

  public async beforeUpload(file: IUploadedFile, options?: IUploadOptions): Promise<IUploadedFile> {
    // FromFile also falls back on an empty name.
    const fsName = options?.fs || DEFAULT_UPLOAD_FS;
    const container = this.options.container ?? DI.RootContainer;
    const config = fsAccessConfig(fsName, container);
    if (config.mode === 'off') return file;

    const provider = publishedFs(container, fsName) ?? (file.Provider?.Name === fsName ? file.Provider : undefined);
    const path = normalizeFsPath(file.BaseName, basePathOf(provider));
    if (path === '') throw new InvalidArgument(`upload ${JSON.stringify(file.Name)} has no file name to write to`, 'BaseName');

    const service = await (this.options.service ?? ((domain: string) => domainService(container, domain)))(config.domain);
    await decideFs({
      fsName,
      mode: config.mode,
      service,
      log: this.options.log ?? engineLog('authz-fs'),
      principal: (this.options.principal ?? currentPrincipal)(),
      permission: 'fs:write',
      ref: refOf(fsName, path, 'file'),
      subject: fsRowOf(fsName, path, 'file'),
    });
    return file;
  }
}
