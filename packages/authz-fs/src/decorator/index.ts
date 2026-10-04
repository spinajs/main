import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { FsDecorator } from '@spinajs/fs';
import type { IProviderConfiguration, fs } from '@spinajs/fs';

import { fsAccessConfig } from '../config/index.js';
import { guardFs } from '../guard/index.js';

/** Guards every filesystem with an `authz.fs.<name>` entry whose mode is not 'off' (design §13). */
@Injectable(FsDecorator)
export class AuthzFsDecorator extends FsDecorator {
  readonly order = 100;

  /** Where the Configuration and AuthzDomains are resolved. */
  constructor(protected readonly container: IContainer = DI.RootContainer) {
    super();
  }

  decorate(instance: fs, config: IProviderConfiguration): fs {
    const access = fsAccessConfig(config.name, this.container);
    return access.mode === 'off' ? instance : guardFs(instance, config.name, { config: access, container: this.container });
  }
}
