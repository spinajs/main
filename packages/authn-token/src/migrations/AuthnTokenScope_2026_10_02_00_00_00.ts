import { OrmMigration, OrmDriver, Migration, DatetimeValueConverter } from '@spinajs/orm';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';

const TABLE = 'rbac_access_tokens';

/**
 * 3.0 token columns (design §22.16) and the expiry back-fill for 2.x tokens
 * that never expire (§22.18).
 */
@Migration('default')
export class AuthnTokenScope_2026_10_02_00_00_00 extends OrmMigration {
  @Config('authn.token.maxTtlDays', { defaultValue: 90 })
  protected MaxTtlDays: number;

  public async up(connection: OrmDriver): Promise<void> {
    // One ALTER per call: the builder runs the statements of a single call concurrently.
    // The builder rather than raw SQL, because DATETIME is not a postgres type.
    await connection.schema().alterTable(TABLE, (table) => {
      table.text('Scope');
    });
    await connection.schema().alterTable(TABLE, (table) => {
      table.string('Kind', 16).notNull().default().value('pat');
    });
    await connection.schema().alterTable(TABLE, (table) => {
      table.dateTime('RevokedAt');
    });
    await connection.schema().alterTable(TABLE, (table) => {
      table.string('LastUsedIp', 64);
    });

    await this.backfillExpiry(connection);
  }

  // The expiry back-fill is not reverted: the old code reads an ExpiresAt fine.
  public async down(connection: OrmDriver): Promise<void> {
    for (const column of ['Scope', 'Kind', 'RevokedAt', 'LastUsedIp']) {
      await connection.schema().alterTable(TABLE, (table) => {
        table.dropColumn(column);
      });
    }
  }

  private async backfillExpiry(connection: OrmDriver): Promise<void> {
    // The driver's own converter reads CreatedAt the way the model does, whatever the dialect returns.
    const converter = connection.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter);
    const rows = (await connection.select().from(TABLE).whereNull('ExpiresAt')) as Array<{ Id: number; CreatedAt: unknown }>;

    for (const row of rows) {
      const createdAt = converter.fromDB(row.CreatedAt) as DateTime | null;
      if (!createdAt?.isValid) {
        throw new Error(`Cannot back-fill ExpiresAt of ${TABLE} row ${row.Id}: unreadable CreatedAt`);
      }

      await connection
        .update()
        .in(TABLE)
        .update({ ExpiresAt: createdAt.plus({ days: this.MaxTtlDays }) })
        .where({ Id: row.Id });
    }
  }
}
