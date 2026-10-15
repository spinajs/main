import * as chai from 'chai';
import 'mocha';

import { DI } from '@spinajs/di';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE, AuthzResourceAncestor_2026_10_14_00_00_00, chunks } from '../../src/ancestors/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

describe('authz_resource_ancestor migration', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  it('is registered on the default connection, as the RBAC migration', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(AuthzResourceAncestor_2026_10_14_00_00_00);
    expect((AuthzResourceAncestor_2026_10_14_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal('default');
  });

  it('chunks a list', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).to.deep.equal([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).to.deep.equal([]);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      afterEach(async () => {
        await dropAncestorTable(db, dialect);
      });

      it('creates the table with its primary key and the up index; down drops it', async () => {
        await createAncestorTable(db, dialect);
        const driver = db.driver(dialect);
        expect(await driver.schema().tableExists(AUTHZ_RESOURCE_ANCESTOR_TABLE)).to.equal(true);
        await insertLinks(driver, ['task:7>project:3@1']);
        let duplicate: unknown;
        try {
          await insertLinks(driver, ['task:7>project:3@2']);
        } catch (e) {
          duplicate = e;
        }
        expect(duplicate, 'the primary key refuses a second row for the same pair').to.be.instanceOf(Error);
        expect(await ancestorLinks(driver)).to.deep.equal(['task:7>project:3@1']);
        const indexes = dialect === 'sqlite' ? ((await db.raw(`PRAGMA index_list("${AUTHZ_RESOURCE_ANCESTOR_TABLE}")`)) as { name: string }[]).map((i) => i.name) : ((await db.raw(`SELECT indexname AS name FROM pg_indexes WHERE tablename = $1`, [AUTHZ_RESOURCE_ANCESTOR_TABLE], 'postgres')) as { name: string }[]).map((i) => i.name);
        expect(indexes).to.include('authz_resource_ancestor_up');
        await new AuthzResourceAncestor_2026_10_14_00_00_00().down(driver);
        expect(await driver.schema().tableExists(AUTHZ_RESOURCE_ANCESTOR_TABLE)).to.equal(false);
      });
    });
  }
});
