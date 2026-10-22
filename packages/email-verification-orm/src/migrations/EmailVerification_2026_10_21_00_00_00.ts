import { Migration, OrmMigration, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { DEFAULT_ORM_CONNECTION, ormConnection } from '../connection.js';
import { ENTRIES_TABLE, META_TABLE, SOURCES_TABLE, VERDICTS_TABLE } from '../tables.js';

/**
 * Lists are stored as generations: a source row points at its live `gen`, and a write
 * fills a new generation before it moves the pointer (OrmEmailVerificationStore).
 */
@Migration(DEFAULT_ORM_CONNECTION)
export class EmailVerification_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(VERDICTS_TABLE, (t) => {
      t.string('key', 300).notNull().primaryKey().exact();
      t.string('result', 8).notNull();
      t.string('reason', 64);
      t.string('source', 80);
      t.bigint('checked_at').notNull();
      t.bigint('expires_at').notNull();
    });
    await connection.index().table(VERDICTS_TABLE).name('ev_verdicts_expires').columns(['expires_at']);

    await connection.schema().createTable(SOURCES_TABLE, (t) => {
      t.string('key', 80).notNull().primaryKey().exact();
      t.string('gen', 36).notNull().exact();
    });

    await connection.schema().createTable(ENTRIES_TABLE, (t) => {
      t.string('key', 300).notNull().primaryKey().exact();
      t.string('gen', 36).notNull().exact();
      t.string('domain', 253).notNull().exact();
      t.bigint('created_at').notNull();
    });
    // Serves the per-generation reads and deletes, and the cleanup's MAX(created_at) ... GROUP BY gen.
    await connection.index().table(ENTRIES_TABLE).name('ev_entries_gen_created').columns(['gen', 'created_at']);

    await connection.schema().createTable(META_TABLE, (t) => {
      t.string('key', 128).notNull().primaryKey().exact();
      t.text('value').notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    for (const table of [VERDICTS_TABLE, SOURCES_TABLE, ENTRIES_TABLE, META_TABLE]) await connection.schema().dropTable(table);
  }
}

// Read when the migrations run, so the tables land on the connection the store uses.
Object.defineProperty(extractMigrationDescriptor(EmailVerification_2026_10_21_00_00_00)!, 'Connection', { get: () => ormConnection(), enumerable: true, configurable: true });
