import 'mocha';

import { runThrottleConformance, throttleParams } from '@spinajs/authn-testing';

import { DbAuthnThrottle } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';
import { QueryContext } from '@spinajs/orm';

for (const kind of DB_KINDS) {
  describe(`DbAuthnThrottle conformance (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'throttle_conf');
    });

    after(async () => {
      await db?.dispose();
    });

    runThrottleConformance(
      async (ctx) => {
        await rawQuery(db.driver, 'DELETE FROM authn_throttle', [], QueryContext.Delete);
        const params = throttleParams(ctx.config);
        return { throttle: { throttle: new DbAuthnThrottle(db.driver, params), params } };
      },
      { title: `throttle conformance (${kind})`, timeoutMs: 30000 },
    );
  });
}
