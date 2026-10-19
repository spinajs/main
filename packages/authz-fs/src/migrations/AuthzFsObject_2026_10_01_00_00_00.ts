import { Migration, OrmMigration, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { fsMetadataConnection } from '../metadata/connection.js';

/** fs_object of design §9.1 (OrmFileMetadataStore), plus updated_at. */
@Migration('default')
export class AuthzFsObject_2026_10_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('fs_object', (table) => {
      for (const [name, length] of [
        ['fs', 64],
        ['path', 512],
      ] as const) {
        // byte-for-byte keys, so case variants of a path stay two rows
        table.string(name, length).notNull().primaryKey().exact();
      }
      table.string('owner_type', 32);
      table.string('owner_id', 64);
      table.string('scope_type', 64);
      table.string('scope_id', 64);
      table.text('tags');
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('fs_object');
  }
}

// Read when the migrations run, so the table lands on the connection OrmFileMetadataStore uses.
Object.defineProperty(extractMigrationDescriptor(AuthzFsObject_2026_10_01_00_00_00)!, 'Connection', { get: () => fsMetadataConnection(), enumerable: true, configurable: true });
