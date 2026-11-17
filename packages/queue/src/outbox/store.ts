import { rowsAffected, type OrmDriver } from '@spinajs/orm';
import { OUTBOX_TABLE, toOutboxRow, type NewOutboxRow, type OutboxRow } from './row.js';

/** Every statement on queue_outbox. Every write after the insert is fenced by the RowLease columns. */
export class OutboxStore {
  constructor(public readonly driver: OrmDriver) {}

  public async insert(row: NewOutboxRow): Promise<boolean> {
    // INSERT OR IGNORE / ON CONFLICT DO NOTHING: a duplicate MessageId must not abort the caller's transaction on Postgres
    return rowsAffected(await this.driver.insert().into(OUTBOX_TABLE).values(row).orIgnore()) === 1;
  }

  public async find(messageId: string): Promise<OutboxRow | undefined> {
    const rows = await this.driver.select<Record<string, unknown>[]>().from(OUTBOX_TABLE).where('MessageId', messageId).onPrimary();
    // MySQL (PAD SPACE collations) and SQL Server compare 'a1' equal to 'a1 '; only the exact id is this message's row
    return rows.map(toOutboxRow).find((row) => row.MessageId === messageId);
  }
}
