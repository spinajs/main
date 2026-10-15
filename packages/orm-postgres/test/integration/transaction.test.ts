import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import './migrations/PgTypesMigration_2026_10_15_00_02_00.js';
import { IPgSuite, openSuite, sqlState } from './harness.js';
import { PgTxUser } from './models/types.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('postgres integration - transactions', function () {
  let suite: IPgSuite;

  const count = async () => Number((await suite.raw<{ n: string }[]>('SELECT count(*) AS n FROM "pg_tx_user"'))[0].n);
  const names = async () => (await suite.raw<{ Name: string }[]>('SELECT "Name" FROM "pg_tx_user" ORDER BY "Name"')).map((r) => r.Name);

  before(async function () {
    // two connections make a leaked one hang the release tests instead of passing quietly
    suite = await openSuite(this, { name: 'tx', pool: { Max: 2 } });
  });

  beforeEach(async () => {
    await suite.reset('pg_tx_user');
  });

  after(async () => {
    await suite?.close();
  });

  it('commits on success and returns the callback result', async () => {
    const result = await suite.driver.transaction(async () => {
      await PgTxUser.create({ Name: 'a' });
      return 'the-value';
    });

    expect(result).to.equal('the-value');
    expect(await count()).to.equal(1);
  });

  it('rolls back on throw, including model writes made through the ambient connection', async () => {
    await expect(
      suite.driver.transaction(async () => {
        await PgTxUser.create({ Name: 'a' });
        expect(await count()).to.equal(1);
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(await count()).to.equal(0);
  });

  it('rolls back a failed inner savepoint and keeps the outer transaction', async () => {
    await suite.driver.transaction(async () => {
      await PgTxUser.create({ Name: 'outer' });
      await suite.driver
        .transaction(async () => {
          await PgTxUser.create({ Name: 'inner' });
          throw new Error('inner fails');
        })
        .catch(() => undefined);
    });

    expect(await names()).to.deep.equal(['outer']);
  });

  it('recovers from a failed statement inside a nested transaction', async () => {
    await suite.driver.transaction(async () => {
      await suite.driver
        .transaction(async () => {
          await suite.raw('SELECT * FROM "no_such_table"');
        })
        .catch(() => undefined);
      await PgTxUser.create({ Name: 'after-failure' });
    });

    expect(await names()).to.deep.equal(['after-failure']);
  });

  it('aborts the whole transaction after a failed statement outside a savepoint (Postgres semantics)', async () => {
    const err = await suite.driver
      .transaction(async () => {
        await suite.raw('SELECT * FROM "no_such_table"').catch(() => undefined);
        await PgTxUser.create({ Name: 'never' });
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(sqlState(err)).to.equal('25P02');
    expect(await count()).to.equal(0);
  });

  it('folds three levels of nesting into the outer commit, rolling back only the failed level', async () => {
    await suite.driver.transaction(async () => {
      await PgTxUser.create({ Name: 'l1' });
      await suite.driver.transaction(async () => {
        await PgTxUser.create({ Name: 'l2' });
        await suite.driver
          .transaction(async () => {
            await PgTxUser.create({ Name: 'l3' });
            throw new Error('l3 fails');
          })
          .catch(() => undefined);
      });
    });

    expect(await names()).to.deep.equal(['l1', 'l2']);
  });

  it('sets the requested isolation level on the transaction', async () => {
    await suite.driver.transaction(
      async () => {
        const [row] = await suite.raw<{ level: string }[]>(`SELECT current_setting('transaction_isolation') AS level`);
        expect(row.level).to.equal('serializable');
      },
      { isolation: 'SERIALIZABLE' },
    );
  });

  it('keeps a REPEATABLE READ snapshot against a concurrent commit', async () => {
    await suite.driver.transaction(
      async () => {
        expect(await count()).to.equal(0);
        await suite.external('INSERT INTO "pg_tx_user" ("Name") VALUES (?)', ['other-session']);
        expect(await count()).to.equal(0);
      },
      { isolation: 'REPEATABLE READ' },
    );

    expect(await count()).to.equal(1);
  });

  it('sees a concurrent commit under READ COMMITTED', async () => {
    await suite.driver.transaction(
      async () => {
        await suite.external('INSERT INTO "pg_tx_user" ("Name") VALUES (?)', ['other-session']);
        expect(await count()).to.equal(1);
      },
      { isolation: 'READ COMMITTED' },
    );
  });

  it('releases the pooled connection on commit and on rollback', async () => {
    for (let i = 0; i < 50; i++) {
      await suite.driver.transaction(async () => {
        await count();
      });
      await suite.driver
        .transaction(async () => {
          throw new Error('nope');
        })
        .catch(() => undefined);
    }

    expect(suite.driver.poolMetrics().InUse).to.equal(0);
  });
});
