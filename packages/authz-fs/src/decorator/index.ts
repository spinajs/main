import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { FsDecorator } from '@spinajs/fs';
import type { IProviderConfiguration, fs } from '@spinajs/fs';

import { fsAccessConfig } from '../access-config/index.js';
import { assertFsDomainConfig, ensureFsDomain } from '../domain/index.js';
import { guardFs } from '../guard/index.js';

/** Guards every filesystem with an `authz.fs.<name>` entry whose mode is not 'off' (design §13). */
@Injectable(FsDecorator)
export class AuthzFsDecorator extends FsDecorator {
  readonly order = 100;

  /** Where the Configuration and AuthzDomains are resolved. */
  constructor(protected readonly container: IContainer = DI.RootContainer) {
    super();
  }

  /** Also creates the filesystem's authz domain with its fs models (D11), before anything asks for its service. */
  decorate(instance: fs, config: IProviderConfiguration): fs {
    const access = fsAccessConfig(config.name, this.container);
    if (access.mode === 'off') return instance;
    assertFsDomainConfig(config.name, access);
    ensureFsDomain(access.domain, this.container);
    return guardFs(instance, config.name, { config: access, container: this.container });
  }
}
