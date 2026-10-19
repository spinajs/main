import { Migration, OrmMigration, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { fsAclConfig } from '../access-config/acl-config.js';

/** fs_acl of the fs middleware design §3.1 (OrmFileAclStore). */
@Migration('default')
export class AuthzFsAcl_2026_10_17_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('fs_acl', (table) => {
      table.string('id', 36).notNull().primaryKey();
      // byte-for-byte keys, so case variants of a path, a subject key or a relation stay apart
      for (const [name, length] of [
        ['fs', 64],
        ['path', 512],
        ['path_hash', 64],
        ['subject_key', 200],
        ['relation', 64],
      ] as const) {
        table.string(name, length).notNull().exact();
      }
      table.dateTime('expires_at');
      table.string('granted_by', 100);
      table.dateTime('created_at').notNull();
    });
    // path_hash, not path: 392 characters stay under InnoDB's 3072-byte key limit in utf8mb4 (path alone is 2048 bytes).
    await connection.index().unique().table('fs_acl').name('fs_acl_uq').columns(['fs', 'path_hash', 'subject_key', 'relation']);
    await connection.index().table('fs_acl').name('fs_acl_path').columns(['fs', 'path_hash', 'relation']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('fs_acl');
  }
}

// Read when the migrations run, so the table lands on the connection OrmFileAclStore uses.
Object.defineProperty(extractMigrationDescriptor(AuthzFsAcl_2026_10_17_00_00_00)!, 'Connection', { get: () => fsAclConfig().connection, enumerable: true, configurable: true });
