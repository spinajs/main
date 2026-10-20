import * as chai from 'chai';
import 'mocha';

import { TestDb } from './db.js';

const expect = chai.expect;

describe('TestDb', function () {
  this.timeout(60000);

  it('opens Postgres on a database of its own, with jit off, and drops it on close', async function () {
    if (!(await TestDb.postgresReachable())) return this.skip();
    const first = await TestDb.open({ postgres: true });
    const name = first.driver('postgres').Options.Database;
    try {
      expect(name).to.match(/^authz_orm_[0-9a-f]{8}$/);
      expect(await first.raw('SHOW jit', [], 'postgres')).to.deep.equal([{ jit: 'off' }]);
    } finally {
      await first.close();
    }

    const second = await TestDb.open({ postgres: true });
    try {
      expect(second.driver('postgres').Options.Database).to.not.equal(name);
      expect(await second.raw('SELECT datname FROM pg_database WHERE datname = $1', [name], 'postgres')).to.deep.equal([]);
    } finally {
      await second.close();
    }
  });
});
