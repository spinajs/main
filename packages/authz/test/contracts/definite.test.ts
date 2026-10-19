import * as chai from 'chai';
import 'mocha';

import * as root from '../../src/index.js';
import { definite } from '../../src/contracts/decision.js';
import type { Decision } from '../../src/contracts/decision.js';
import { FALSE, TRUE } from '../../src/contracts/filter.js';
import type { ResourceFilter } from '../../src/contracts/filter.js';

const expect = chai.expect;

const decision = (allowed: boolean, residual: ResourceFilter): Decision => ({
  allowed,
  permission: 'doc.read',
  resource: { type: 'doc', id: '1' },
  principal: { type: 'user', id: 'u1' },
  residual,
  fields: { read: [], write: [] },
  roles: {},
  domain: 'root',
});

describe('definite', () => {
  it('is exported from the package root', () => {
    expect(root.definite).to.equal(definite);
  });

  it('holds only for a permit without a residual', () => {
    expect(definite(decision(true, TRUE))).to.equal(true);
    expect(definite(decision(true, { op: 'relation', relation: 'owner' } as ResourceFilter))).to.equal(false);
    expect(definite(decision(true, { op: 'cmp', field: 'owner', cmp: 'eq', value: 'u1' }))).to.equal(false);
    expect(definite(decision(false, FALSE))).to.equal(false);
    expect(definite(decision(false, TRUE))).to.equal(false);
  });

  it('is false for a permit that carries no residual at all', () => {
    expect(definite({ ...decision(true, TRUE), residual: undefined } as unknown as Decision)).to.equal(false);
  });
});
