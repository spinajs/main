import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IWhereBuilder } from '@spinajs/orm';

import { PlanTermCompiler } from '../../src/plan/index.js';
import { RelationOwnerTerm, RelationSelfTerm, planTermCompilers } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

class FlagA extends PlanTermCompiler {
  readonly op = 'test.flag';

  apply(_args: unknown, where: IWhereBuilder<unknown>): void {
    where.where(true);
  }
}
class FlagB extends FlagA {}

describe('PlanTermCompiler registry', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  // Unregistering leaves the resolved instances in the cached PlanTermCompiler array, here and in suites run before.
  const uncache = () => DI.RootContainer.uncache(PlanTermCompiler);
  beforeEach(uncache);
  afterEach(uncache);

  it('lists the registered compilers by op, relation.owner and relation.self built in', () => {
    const undo = testHost.registerInRoot(PlanTermCompiler, FlagA);
    try {
      const map = planTermCompilers();
      expect(map.get('relation.owner')).to.be.instanceOf(RelationOwnerTerm);
      expect(map.get('relation.self')).to.be.instanceOf(RelationSelfTerm);
      expect(map.get('test.flag')).to.be.instanceOf(FlagA);
    } finally {
      undo();
    }
  });

  it('refuses two compilers for one op', () => {
    const undo = [testHost.registerInRoot(PlanTermCompiler, FlagA), testHost.registerInRoot(PlanTermCompiler, FlagB)];
    try {
      expect(() => planTermCompilers()).to.throw(AuthzConfigError, /two PlanTermCompilers for op "test\.flag" \(FlagA, FlagB\)/);
    } finally {
      undo.forEach((u) => u());
    }
  });
});
