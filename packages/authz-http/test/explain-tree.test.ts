import 'mocha';
import { expect } from 'chai';
import { FALSE, TRUE } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';

import { explainTree } from '../src/index.js';

const base = { permission: 'doc:edit', resource: { type: 'doc', id: '1' }, principal: { type: 'user', id: 'alice' }, fields: { read: ['*'], write: ['*'] }, roles: {}, domain: 'root' };

describe('explainTree (design §10.6)', () => {
  it('maps the decision, each vote with its steps, then the engine steps', () => {
    const decision: Decision = {
      ...base,
      allowed: true,
      residual: TRUE,
      trace: {
        domain: 'root',
        algorithm: 'deny-overrides',
        models: ['rbac', 'abac'],
        durationMs: 3,
        votes: [
          { model: 'rbac', permitWhen: TRUE, denyWhen: FALSE, cacheable: true, trace: [{ by: 'rbac', step: 'role', note: 'editor at doc:1', data: { x: 1 } }] },
          { model: 'abac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true },
        ],
        steps: [{ by: 'core', step: 'combine', note: 'deny-overrides: permit' }],
      },
    };

    expect(explainTree(decision)).to.deep.equal({
      label: 'doc:1#doc:edit = allow',
      allowed: true,
      children: [
        { label: 'rbac: permit', allowed: true, children: [{ label: 'rbac role: editor at doc:1', allowed: true, children: [] }] },
        { label: 'abac: abstain', allowed: false, children: [] },
        { label: 'deny-overrides over [rbac, abac] in root', allowed: true, children: [{ label: 'core combine: deny-overrides: permit', allowed: true, children: [] }] },
      ],
    });
  });

  it('labels deny, error, conditional and abstain-with-reason votes', () => {
    const cond = { op: 'cmp', field: 'status', cmp: 'eq', value: 'open' } as const;
    const decision: Decision = {
      ...base,
      allowed: false,
      residual: FALSE,
      reason: { code: 'role_denied', model: 'rbac' },
      trace: {
        domain: 'root',
        algorithm: 'deny-overrides',
        models: ['rbac', 'abac', 'x', 'y'],
        durationMs: 1,
        votes: [
          { model: 'rbac', permitWhen: FALSE, denyWhen: TRUE, reason: { code: 'role_denied' }, cacheable: true },
          { model: 'abac', permitWhen: cond, denyWhen: FALSE, cacheable: true },
          { model: 'x', permitWhen: FALSE, denyWhen: FALSE, error: 'timeout', cacheable: false },
          { model: 'y', permitWhen: FALSE, denyWhen: FALSE, reason: { code: 'no_access' }, cacheable: true },
        ],
        steps: [],
      },
    };

    const tree = explainTree(decision);
    expect(tree.label).to.eq('doc:1#doc:edit = deny (role_denied)');
    expect(tree.allowed).to.eq(false);
    expect(tree.children.map((c) => [c.label, c.allowed])).to.deep.equal([
      ['rbac: deny (role_denied)', false],
      ['abac: conditional', false],
      ['x: error (timeout)', false],
      ['y: abstain (no_access)', false],
      ['deny-overrides over [rbac, abac, x, y] in root', false],
    ]);
  });

  it('marks a conditional decision not allowed, and has no children without a trace', () => {
    const tree = explainTree({ ...base, allowed: true, residual: { op: 'cmp', field: 'status', cmp: 'eq', value: 'open' } });
    expect(tree).to.deep.equal({ label: 'doc:1#doc:edit = conditional', allowed: false, children: [] });
  });
});
