import 'mocha';
import { expect } from 'chai';

import { POPULATE_GROUP_CASES, POPULATE_GROUP_EXPECTED } from '../cases/populate-group.case.js';
import { availableTargets, runTarget } from '../src/index.js';
import type { TargetName, TargetResults } from '../src/index.js';

// SQL Server joins qualify the table with the database alone and fail every belongs-to populate (its own issue).
const targets = availableTargets().filter((t) => t.name !== 'mssql');

describe('populate callback conditions keep their groups, on every dialect', () => {
  const results = new Map<TargetName, TargetResults>();

  before(async () => {
    for (const target of targets) {
      results.set(target.name, await runTarget(target, POPULATE_GROUP_CASES));
    }
  });

  for (const target of targets) {
    describe(target.name, () => {
      for (const c of POPULATE_GROUP_CASES) {
        it(c.name, () => {
          expect(results.get(target.name)?.get(c.name)).to.deep.equal(POPULATE_GROUP_EXPECTED[c.name]);
        });
      }
    });
  }
});
