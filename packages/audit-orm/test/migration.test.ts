import { expect } from 'chai';
import 'mocha';
import type { OrmDriver, OrmMigration } from '@spinajs/orm';
import { AuditArchiveTableMigration, AuditTrailTableMigration } from '../src/index.js';
import { TestDb } from './support/db.js';

class BillingTrailMigration extends AuditTrailTableMigration {
  protected override table(): string {
    return 'audit_billing';
  }
}

class ShippedArchiveMigration extends AuditArchiveTableMigration {
  protected override table(): string {
    return 'audit_shipped';
  }
}

async function indexColumns(driver: OrmDriver, table: string, name: string): Promise<string[] | undefined> {
  if (!driver.tableIndexes) throw new Error(`driver ${driver.Options.Name} cannot list indexes`);
  return (await driver.tableIndexes(table)).find((i) => i.name === name)?.columns;
}

describe('audit-orm migrations: the subject type feed index', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of TestDb.dialects()) {
    describe(dialect, () => {
      const driver = () => db.driver(dialect);
      const cases: readonly [string, () => OrmMigration, string, string[]][] = [
        ['a trail table', () => new AuditTrailTableMigration(), 'audit_event', ['subject_type', 'seq']],
        ['a trail table of a subclass', () => new BillingTrailMigration(), 'audit_billing', ['subject_type', 'seq']],
        ['an archive table', () => new ShippedArchiveMigration(), 'audit_shipped', ['source', 'subject_type', 'seq']],
      ];

      before(function () {
        if (!db.has(dialect)) this.skip();
      });

      for (const [what, migration, table, columns] of cases) {
        it(`gives ${what} ${table}_type_seq, and survives up, down and up`, async () => {
          await migration().down(driver());
          await migration().up(driver());
          expect(await indexColumns(driver(), table, `${table}_type_seq`)).to.deep.eq(columns);

          await migration().down(driver());
          await migration().up(driver());
          expect(await indexColumns(driver(), table, `${table}_type_seq`)).to.deep.eq(columns);
          await migration().down(driver());
        });
      }
    });
  }
});
