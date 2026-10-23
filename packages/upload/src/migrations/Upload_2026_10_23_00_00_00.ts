import { Migration, OrmMigration, ReferentialAction } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { UPLOAD_BLOBS_TABLE, UPLOAD_CONNECTION, UPLOAD_PARTS_TABLE, UPLOAD_SESSIONS_TABLE } from '../constants.js';

/**
 * Spec §6.1. Uuids are varchar(36): table.uuid() is binary(16) for the UuidConverter (orm/src/builders.ts:2961-2967),
 * and these ids are plain strings. metadata is JSON text read through the Json decorator, as queue_jobs.Result is.
 */
@Migration(UPLOAD_CONNECTION)
export class Upload_2026_10_23_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(UPLOAD_SESSIONS_TABLE, (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('owner', 255);
      table.string('name', 255).notNull();
      table.bigint('size').notNull();
      table.int('part_size').notNull();
      table.int('part_count').notNull();
      table.string('declared_sha256', 64);
      table.string('declared_mime', 255);
      table.string('detected_mime', 255);
      table.string('status', 16).notNull();
      table.text('metadata').notNull();
      table.string('temp_fs', 64).notNull();
      table.string('files_fs', 64).notNull();
      table.string('file_key', 1024);
      table.string('sha256', 64);
      table.string('claim_token', 36);
      table.dateTime('claimed_at');
      table.string('failure_code', 64);
      table.string('failure_message', 1024);
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
      table.dateTime('expires_at').notNull();
      table.dateTime('completed_at');
      table.dateTime('handled_at');
      table.string('final_event', 32);
      table.dateTime('final_event_at');
    });

    // The composite primary key is the unique (session_id, number) the part upsert conflicts on (spike test/spikes/upsert.test.ts).
    await connection.schema().createTable(UPLOAD_PARTS_TABLE, (table) => {
      table.string('session_id', 36).notNull().primaryKey();
      table.int('number').notNull().primaryKey();
      table.bigint('size').notNull();
      table.string('sha256', 64).notNull();
      table.string('storage_key', 1024).notNull();
      table.string('detected_mime', 255);
      table.dateTime('received_at').notNull();
      table.foreignKey('session_id').references(UPLOAD_SESSIONS_TABLE, 'id').onDelete(ReferentialAction.Cascade);
    });

    await connection.schema().createTable(UPLOAD_BLOBS_TABLE, (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('session_id', 36).notNull();
      table.string('fs', 64).notNull();
      table.string('key', 1024).notNull();
      table.string('kind', 8).notNull();
      table.string('state', 16).notNull();
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
      table.foreignKey('session_id').references(UPLOAD_SESSIONS_TABLE, 'id').onDelete(ReferentialAction.Cascade);
    });

    await connection.index().table(UPLOAD_SESSIONS_TABLE).name('upload_sessions_status_expires').columns(['status', 'expires_at']);
    await connection.index().table(UPLOAD_SESSIONS_TABLE).name('upload_sessions_owner_status').columns(['owner', 'status']);
    await connection.index().table(UPLOAD_SESSIONS_TABLE).name('upload_sessions_final_event').columns(['final_event', 'final_event_at']);
    await connection.index().table(UPLOAD_BLOBS_TABLE).name('upload_blobs_state_updated').columns(['state', 'updated_at']);
    await connection.index().table(UPLOAD_BLOBS_TABLE).name('upload_blobs_session').columns(['session_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(UPLOAD_BLOBS_TABLE).ifExists();
    await connection.schema().dropTable(UPLOAD_PARTS_TABLE).ifExists();
    await connection.schema().dropTable(UPLOAD_SESSIONS_TABLE).ifExists();
  }
}
