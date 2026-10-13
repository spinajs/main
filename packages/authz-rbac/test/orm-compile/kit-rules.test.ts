import { runBehaviour } from '@spinajs/authz-testing';
import { expect } from 'chai';
import 'mocha';

import { KINDS } from '../orm/root-orm.js';
import { sqlKitHarness } from './kit-harness.js';

/*
 * Kit acceptance of L4b on the lane SQL harness, strict, on SQLite and Postgres: B06.rulesSql, B44.config, B44.pages,
 * B44.db and B44.write. Every list is one statement whose rows are the list (the harness's query counter), and for
 * file:read authz-orm's middleware lists the same rows.
 */

describe('authz-rbac orm-compile: kit B06.rulesSql and B44 on SQL', () => {
  for (const kind of KINDS) {
    describe(kind, function () {
      this.timeout(1800000);
      const harness = sqlKitHarness({ kind });
      runBehaviour(['B06.rulesSql', 'B44.config', 'B44.pages', 'B44.write', 'B44.db'], () => harness, { strict: true, timeoutMs: 1800000 });

      after(() => {
        const s = harness.stats;
        console.log(`      ${kind}: ${s.lists} lists (${s.ruleLists} with rule terms), ${s.pages} pages, ${s.queries} of them ran SQL in ${s.statements} statements, ${s.listed} rows listed`);
        expect(s.statements, 'one statement per list and per page that ran SQL').to.equal(s.queries);
      });
    });
  }
});
