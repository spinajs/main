import * as chai from 'chai';
import 'mocha';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import { compilePolicy, policyHash } from '@spinajs/authz-ir';
import type { PolicyService } from '@spinajs/authz-ir';

import { AccessResource, Owner, compileDomainPolicy, ormToIR } from '../../src/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

describe('compileDomainPolicy', function () {
  this.timeout(60000);
  let db: TestDb;
  before(async () => {
    db = await TestDb.open();
    await db.define({ name: 'Memo', columns: { author_id: 'TEXT' }, decorate: (c, p) => (AccessResource('memo')(c), Owner()(p, 'author_id')) });
  });
  after(async () => {
    testHost.config().unset(['authz', 'combine']);
    await testHost.resetRoot();
    await db?.close();
  });

  it('adds the ORM relations and the domain combine, and lists models without toIR as opaque', async () => {
    testHost.config().set(['authz', 'combine'], { default: { algorithm: 'permit-overrides' } });
    const service: PolicyService = { models: () => [new StaticModel({ name: 'sm', votes: {} })] };
    const p = await compileDomainPolicy('root', service);
    expect(p.ir.types.memo.relations.owner.source).to.deep.include({ kind: 'column', column: 'author_id' });
    expect(p.ir.combine.default.algorithm).to.equal('permit-overrides');
    expect(p.ir.opaque).to.deep.include({ kind: 'model', name: 'sm' });
    expect(p.hash).to.equal(policyHash(p.ir));
  });

  it('sorts the ORM fragments by model name, so registration order does not change the hash', async () => {
    await db.define({ name: 'Note', columns: { author_id: 'TEXT' }, decorate: (c, p) => (AccessResource('note')(c), Owner()(p, 'author_id')) });
    const combine = { default: { algorithm: 'permit-overrides' } };
    testHost.config().set(['authz', 'combine'], combine);
    const service: PolicyService = { models: () => [] };
    const a = await compileDomainPolicy('root', service);
    const fragments = ormToIR();
    const b = await compilePolicy(service, { combine, extra: [...fragments].reverse(), stored: 'opaque' });
    const c = await compilePolicy(service, { combine, extra: [...fragments].sort((x, y) => (x.model < y.model ? -1 : 1)), stored: 'opaque' });
    expect(a.hash).to.equal(c.hash);
    expect(b.hash).to.equal(c.hash);
  });

  it('measures: logs the compile time of the fixture domain and bounds it loosely', async () => {
    const service: PolicyService = { models: () => [new StaticModel({ name: 'sm', votes: {} })] };
    const t = performance.now();
    await compileDomainPolicy('root', service);
    const ms = performance.now() - t;
    console.log(`compileDomainPolicy(root): ${ms.toFixed(1)} ms`);
    expect(ms).to.be.below(500);
  });
});
