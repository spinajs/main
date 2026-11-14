import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SqlDbTimeSource } from '../../src/index.js';
import { bootDb } from '../support/env.js';
import { REAL_DB_TARGETS } from '../support/real-db.js';

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`database time (${target.name})`, function () {
    this.timeout(30_000);
    after(() => DI.dispose());

    it('reads the server time in epoch milliseconds', async () => {
      await bootDb([{ ...target.connection, Name: 'default' }]);
      const ms = await DI.resolve(SqlDbTimeSource).read();
      expect(ms).to.be.a('number');
      expect(Math.abs(ms - Date.now())).to.be.lessThan(5000);
    });
  });
}
