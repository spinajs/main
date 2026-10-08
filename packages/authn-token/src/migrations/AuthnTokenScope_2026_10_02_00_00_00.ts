import { OrmMigration, OrmDriver, Migration, DatetimeValueConverter, IdentifierQuoter, RawQuery } from '@spinajs/orm';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { DateTime } from 'luxon';

const TABLE = 'rbac_access_tokens';
const COLUMNS = ['Scope', 'Kind', 'RevokedAt', 'LastUsedIp'];

/**
 * 3.0 token columns (design §22.16) and the expiry back-fill for 2.x tokens
 * that never expire (§22.18).
 */
@Migration('default')
export class AuthnTokenScope_2026_10_02_00_00_00 extends OrmMigration {
  @Config('authn.token.maxTtlDays')
  protected MaxTtlDays: number;

  public async up(connection: OrmDriver): Promise<void> {
    const maxTtlDays = this.MaxTtlDays;
    // Before any ALTER: the schema is the gate; this floor holds for a value that never went through it.
    if (!(Number.isFinite(maxTtlDays) && maxTtlDays > 0)) {
      throw new Error(`authn.token.maxTtlDays must be a finite positive number to back-fill the expiry of 2.x tokens, got ${String(maxTtlDays)}`);
    }

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

    await this.backfillExpiry(connection, maxTtlDays);
  }

  // The expiry back-fill is not reverted: the old code reads an ExpiresAt fine.
  public async down(connection: OrmDriver): Promise<void> {
    // Raw, because the builder's DROP COLUMN leaves the name unquoted, which postgres folds to lower case.
    const quoter = connection.Container.resolve<IdentifierQuoter>(IdentifierQuoter);
    for (const column of COLUMNS) {
      await connection.schema().raw(new RawQuery(`ALTER TABLE ${quoter.quote(TABLE)} DROP COLUMN ${quoter.quote(column)}`));
    }
  }

  private async backfillExpiry(connection: OrmDriver, maxTtlDays: number): Promise<void> {
    // The driver's own converter reads CreatedAt the way the model does, whatever the dialect returns.
    const converter = connection.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter);
    const rows = (await connection.select().from(TABLE).whereNull('ExpiresAt')) as Array<{ Id: number; CreatedAt: unknown }>;

    for (const row of rows) {
      let createdAt = converter.fromDB(row.CreatedAt) as DateTime | null;
      if (!createdAt?.isValid) {
        // The sqlite column default writes ISO text (`T`, `Z`), which the SQL-format converter rejects.
        createdAt = DateTime.fromISO(String(row.CreatedAt));
      }
      if (!createdAt.isValid) {
        throw new Error(`Cannot back-fill ExpiresAt of ${TABLE} row ${row.Id}: unreadable CreatedAt`);
      }

      await connection
        .update()
        .in(TABLE)
        .update({ ExpiresAt: createdAt.plus({ days: maxTtlDays }) })
        .where({ Id: row.Id });
    }
  }
}
