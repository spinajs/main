import { Migration, OrmMigration, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { fsAclConfig } from '../access-config/acl-config.js';

/** Index of fs_acl on (fs, path) for the path prefix reads of OrmFileAclStore. */
@Migration('default')
export class AuthzFsAclPathIndex_2026_10_21_00_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {
    throw new Error('not implemented: AuthzFsAclPathIndex.up');
  }

  public async down(_connection: OrmDriver): Promise<void> {
    throw new Error('not implemented: AuthzFsAclPathIndex.down');
  }
}

// Read when the migrations run, so the index lands on the connection OrmFileAclStore uses.
Object.defineProperty(extractMigrationDescriptor(AuthzFsAclPathIndex_2026_10_21_00_00_00)!, 'Connection', { get: () => fsAclConfig().connection, enumerable: true, configurable: true });
