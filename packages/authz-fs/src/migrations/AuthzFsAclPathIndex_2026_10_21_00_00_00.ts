import { Migration, OrmMigration, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { fsAclConfig } from '../access-config/acl-config.js';

/** Index of fs_acl on (fs, path) for the path prefix reads of OrmFileAclStore. */
@Migration('default')
export class AuthzFsAclPathIndex_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // The unique key leads with path_hash and cannot serve `path LIKE 'dir/%'`. Unlike that key this one stays under
    // InnoDB's 3072-byte limit: fs (64) plus path (512) is 2304 bytes in utf8mb4.
    await connection.index().table('fs_acl').name('fs_acl_fs_path').columns(['fs', 'path']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.index().table('fs_acl').name('fs_acl_fs_path').drop();
  }
}

// Read when the migrations run, so the index lands on the connection OrmFileAclStore uses.
Object.defineProperty(extractMigrationDescriptor(AuthzFsAclPathIndex_2026_10_21_00_00_00)!, 'Connection', { get: () => fsAclConfig().connection, enumerable: true, configurable: true });
