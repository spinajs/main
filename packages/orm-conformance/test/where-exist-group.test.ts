import 'mocha';
import { expect } from 'chai';

import { WHERE_EXIST_GROUP_CASES, WHERE_EXIST_GROUP_EXPECTED } from '../cases/where-exist-group.case.js';
import { availableTargets, runTarget } from '../src/index.js';
import type { TargetName, TargetResults } from '../src/index.js';

describe('a whereExist callback with an OR keeps the correlation, on every dialect', () => {
  const targets = availableTargets();
  const results = new Map<TargetName, TargetResults>();

  before(async () => {
    for (const target of targets) {
      results.set(target.name, await runTarget(target, WHERE_EXIST_GROUP_CASES));
    }
  });

  for (const target of targets) {
    describe(target.name, () => {
      for (const c of WHERE_EXIST_GROUP_CASES) {
        it(c.name, () => {
          expect(results.get(target.name)?.get(c.name)).to.deep.equal(WHERE_EXIST_GROUP_EXPECTED[c.name]);
        });
      }
    });
  }
});
