import { AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { fsAccessConfigs } from '../access-config/index.js';
import { assertFsDomainConfig } from '../domain/index.js';
import { effectiveFsOperations } from '../operations/index.js';

/**
 * Hands a domain every permission of the effective operation table of each filesystem it checks, so an
 * `authz.fs.<name>.operations` entry naming an unregistered permission fails that domain's boot (design §6.5
 * rule 7), and so do the `authz.fs.<name>.inherit` keys. Registered in root: a domain's boot asks the contributors of
 * its whole container chain. Every domain's boot also fails on a filesystem config that root cannot serve
 * (`assertFsDomainConfig`).
 */
@Injectable(AuthzContributor)
export class FsAuthzContributor extends AuthzContributor {
  /** Where the Configuration is resolved. */
  constructor(protected readonly container: IContainer = DI.RootContainer) {
    super();
  }

  contribute(domain: string): AuthzContribution {
    const refs = new Map<string, PermissionRefDecl>();
    for (const [name, config] of fsAccessConfigs(this.container)) {
      assertFsDomainConfig(name, config);
      if (config.mode === 'off' || config.domain !== domain) continue;
      const inherit = `authz.fs.${name}.inherit`;
      for (const permission of Object.keys(config.inherit ?? {})) {
        for (const type of ['file', 'dir'] as const) refs.set(`${permission}\0${type}\0${inherit}`, { permission, type, source: inherit });
      }
      for (const [method, operation] of Object.entries(effectiveFsOperations(config, name))) {
        const source = config.operations && Object.hasOwn(config.operations, method) ? `authz.fs.${name}.operations.${method}` : `authz.fs.${name}`;
        for (const spec of operation.paths) {
          // Any path argument may be the filesystem root, which the guard checks as the fs ref.
          for (const permission of spec.permissions) {
            for (const type of [spec.kind, 'fs'] as const) refs.set(`${permission}\0${type}\0${source}`, { permission, type, source });
          }
        }
      }
    }
    return { permissionRefs: [...refs.values()] };
  }
}
