import 'mocha';
import { expect } from 'chai';

import { CaveatEvaluator, IREvaluator, MemoryTupleSource } from '../../src/index.js';
import type { CaveatContext, PolicyIR, Truth } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const at = new Date('2026-11-04T10:00:00Z');
const u = { type: 'user', id: 'u1' };
const d1 = { type: 'doc', id: 'd1' };

function caveat(ir: PolicyIR, name: string, context?: CaveatContext, tuple?: Record<string, unknown>, attributes?: Record<string, unknown>): Promise<Truth> {
  return new CaveatEvaluator(ir).evaluate(name, { principal: { ...u, attributes }, permission: 'doc:publish', resource: d1, context, at }, tuple);
}

describe('caveats', () => {
  it('evaluates resource attributes as the engine does; a missing attribute is unknown', async () => {
    expect(await caveat(docsIR(), 'not_frozen', { resource: { status: 'draft' } })).to.equal('allow');
    expect(await caveat(docsIR(), 'not_frozen', { resource: { status: 'frozen' } })).to.equal('deny');
    expect(await caveat(docsIR(), 'not_frozen', { resource: {} })).to.equal('unknown');
    expect(await caveat(docsIR(), 'not_frozen')).to.equal('unknown');
  });

  it('reads env, principal attributes and scope attributes; missing ones are unknown', async () => {
    const ir = docsIR();
    ir.caveats.level = { params: { 'principal.attributes.level': 'int' }, expr: { attr: 'principal.attributes.level', gte: 3 } };
    ir.caveats.open = { params: { 'scope.org.open': 'bool' }, expr: { attr: 'scope.org.open', eq: true } };
    expect(await caveat(ir, 'office_hours', { env: { hour: 10 } })).to.equal('allow');
    expect(await caveat(ir, 'office_hours', { env: { hour: 20 } })).to.equal('deny');
    expect(await caveat(ir, 'office_hours', {})).to.equal('unknown');
    expect(await caveat(ir, 'level', {}, undefined, { level: 5 })).to.equal('allow');
    expect(await caveat(ir, 'level', { principal: { attributes: { level: 1 } } }, undefined, { level: 5 })).to.equal('deny');
    expect(await caveat(ir, 'level', {})).to.equal('unknown');
    expect(await caveat(ir, 'open', { scope: { org: { open: true } } })).to.equal('allow');
    expect(await caveat(ir, 'open', { scope: {} })).to.equal('unknown');
  });

  it('lets a conditional tuple supply parameters, over the request context', async () => {
    expect(await caveat(docsIR(), 'office_hours', {}, { 'env.hour': 11 })).to.equal('allow');
    expect(await caveat(docsIR(), 'office_hours', { env: { hour: 11 } }, { 'env.hour': 22 })).to.equal('deny');
  });

  it('is unknown for an unknown caveat or an unregistered condition function', async () => {
    const ir = docsIR();
    ir.caveats.custom = { params: {}, expr: { fn: 'acme.check' } };
    expect(await caveat(ir, 'missing', {})).to.equal('unknown');
    expect(await caveat(ir, 'custom', {})).to.equal('unknown');
  });

  it('caveats a rewrite and a conditional tuple inside a check', async () => {
    const source = new MemoryTupleSource().add(d1, 'editor', { type: 'user', id: 'u5', caveat: { name: 'office_hours' } }).add(d1, 'editor', u);
    const ev = new IREvaluator(docsIR(), source);
    const check = async (principal: typeof u, permission: string, context?: CaveatContext): Promise<Truth> => (await ev.check({ principal, permission, resource: d1, context, at })).truth;
    expect(await check(u, 'doc:publish', { resource: { status: 'draft' } })).to.equal('allow');
    expect(await check(u, 'doc:publish', { resource: { status: 'frozen' } })).to.equal('deny');
    expect(await check(u, 'doc:publish')).to.equal('unknown');
    const u5 = { type: 'user', id: 'u5' };
    expect(await check(u5, 'doc:update', { env: { hour: 10 } })).to.equal('allow');
    expect(await check(u5, 'doc:update', { env: { hour: 23 } })).to.equal('deny');
    expect(await check(u5, 'doc:update')).to.equal('unknown');
  });

  it('ignores a tuple whose caveat the relation does not admit', async () => {
    const source = new MemoryTupleSource().add(d1, 'banned', { type: 'user', id: 'u1', caveat: { name: 'office_hours' } }).add(d1, 'editor', u);
    expect((await new IREvaluator(docsIR(), source).check({ principal: u, permission: 'doc:read', resource: d1, at })).truth).to.equal('allow');
  });
});
