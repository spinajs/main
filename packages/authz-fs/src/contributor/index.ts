import { AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { fsAccessConfigs } from '../config/index.js';
import { effectiveFsOperations } from '../operations/index.js';

/**
 * Hands a domain every permission of the effective operation table of each filesystem it checks, so an
 * `authz.fs.<name>.operations` entry naming an unregistered permission fails that domain's boot (design §6.5
 * rule 7). Registered in root: a domain's boot asks the contributors of its whole container chain.
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
      if (config.mode === 'off' || config.domain !== domain) continue;
      for (const [method, operation] of Object.entries(effectiveFsOperations(config))) {
        const source = config.operations && Object.hasOwn(config.operations, method) ? `authz.fs.${name}.operations.${method}` : `authz.fs.${name}`;
        for (const spec of operation.paths) {
          for (const permission of spec.permissions) refs.set(`${permission}\0${spec.kind}\0${source}`, { permission, type: spec.kind, source });
        }
      }
    }
    return { permissionRefs: [...refs.values()] };
  }
}
