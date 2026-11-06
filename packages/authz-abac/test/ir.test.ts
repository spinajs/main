import * as chai from 'chai';
import 'mocha';
import { DefaultConditionCompiler, PermissionRegistryImpl } from '@spinajs/authz';
import { IREvaluator, MemoryTupleSource, mergeFragments, validateIR } from '@spinajs/authz-ir';
import type { CaveatContext, PolicyIR, Truth } from '@spinajs/authz-ir';

import { abacToIR, loadPolicy } from '../src/index.js';

const expect = chai.expect;

function registry(): PermissionRegistryImpl {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'invoice:read', list: true }, { name: 'invoice:update' }], 'test');
  r.freeze();
  return r;
}

const parser = new DefaultConditionCompiler();
const load = (raws: readonly Record<string, unknown>[]) => raws.map((raw, i) => loadPolicy(raw, i, { source: 'config' }, (c, where) => parser.parse(c, where)));

const POLICIES = [
  { id: 'staff-read', effect: 'permit', permissions: ['invoice:*'], principalTypes: ['user'], when: { attr: 'principal.attributes.dept', eq: 'finance' } },
  { id: 'frozen-invoices', effect: 'deny', permissions: ['invoice:update'], when: { attr: 'resource.status', eq: 'frozen' }, reason: 'invoice_frozen' },
  { id: 'org-only', effect: 'permit', permissions: ['invoice:read'], scope: { type: 'org', id: 'o1' } },
];

function compile(): PolicyIR {
  const { ir, conflicts } = mergeFragments([abacToIR(load(POLICIES), registry())]);
  expect(conflicts).to.deep.equal([]);
  return ir;
}

async function truth(ir: PolicyIR, permission: string, principal: { type: string; id: string; attributes?: Record<string, unknown> }, context?: CaveatContext): Promise<Truth> {
  return (await new IREvaluator(ir, new MemoryTupleSource(ir)).check({ principal, permission, resource: { type: 'invoice', id: 'i1' }, ...(context ? { context } : {}) })).truth;
}

describe('authz-abac: abacToIR', () => {
  it('compiles permits and denies into caveated relations of the permission type', () => {
    const ir = compile();
    expect(validateIR(ir)).to.deep.equal([]);
    expect(ir.types.invoice.permissions.abac_deny_invoice_update).to.deep.equal({ caveat: 'abac_frozen_invoices', of: { intersection: [] } });
    expect(ir.caveats.abac_staff_read).to.deep.equal({
      params: { 'principal.type': 'string', 'principal.attributes.dept': 'string' },
      expr: { all: [{ attr: 'principal.type', in: ['user'] }, { attr: 'principal.attributes.dept', eq: 'finance' }] },
    });
    expect(ir.permissions['invoice:update']).to.deep.equal({ type: 'invoice', relation: 'perm_invoice_update', list: false, source: { origin: 'config:authz.abac.policies' } });
    expect(ir.opaque).to.deep.equal([{ kind: 'rewrite', name: 'abac scope of policy org-only' }]);
  });

  it('evaluates the caveats: attributes decide, missing attributes and scopes are unknown', async () => {
    const ir = compile();
    const finance = { type: 'user', id: 'u1', attributes: { dept: 'finance' } };
    expect(await truth(ir, 'invoice:update', finance, { resource: { status: 'open' } })).to.equal('allow');
    expect(await truth(ir, 'invoice:update', finance, { resource: { status: 'frozen' } })).to.equal('deny');
    expect(await truth(ir, 'invoice:update', finance)).to.equal('unknown');
    expect(await truth(ir, 'invoice:update', { type: 'service', id: 's1', attributes: { dept: 'finance' } }, { resource: { status: 'open' } })).to.equal('deny');
    expect(await truth(ir, 'invoice:read', finance)).to.equal('allow');
    expect(await truth(ir, 'invoice:read', { type: 'user', id: 'u2', attributes: { dept: 'sales' } })).to.equal('unknown');
  });
});
