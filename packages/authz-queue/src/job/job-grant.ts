import { Injectable } from '@spinajs/di';
import { ConfigurationSource } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';

/**
 * Every user holds job:read on the jobs they emitted (the `owner` relation is the job's initiator). It is a source and not a
 * config file because every installed package's config dir is read whether or not the package is imported, and a
 * grant of a permission nothing registered fails the boot. Order 0 loads before the file sources.
 */
@Injectable(ConfigurationSource)
export class JobGrantSource extends ConfigurationSource {
  public get Order(): number {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({ authz: { rbac: { roles: { user: { grants: [{ permission: 'job:read', relation: 'owner' }] } } } } } as unknown as IConfigLike);
  }
}
