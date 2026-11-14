import { expect } from 'chai';
import 'mocha';

import { FALSE } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';

import { forbidden } from '../../src/access/policy.js';

const denied: Decision = { allowed: false, permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, principal: { type: 'user', id: 'alice' }, residual: FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root', reason: { code: 'no_access' } };

/** The enumerable own properties, which @spinajs/http spreads into the response body. */
const body = (e: object) => Object.fromEntries(Object.keys(e).map((k) => [k, (e as Record<string, unknown>)[k]]));

describe('403 body', () => {
  it("carries the decision's id when it has one (a decision log is registered), in every environment", () => {
    expect(body(forbidden({ ...denied, id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6a' }))).to.deep.include({ error: 'forbidden', decisionId: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6a' });
    expect(body(forbidden(denied))).to.not.have.property('decisionId');
  });
});
