import * as chai from 'chai';
import 'mocha';
import { DefaultConditionCompiler } from '@spinajs/authz';
import type { CaveatDef } from '@spinajs/authz-ir';
import { fakeEvaluationContext, userPrincipal } from '@spinajs/authz-testing';

import { RebacCaveats, overlayContext, pickCaveatInput } from '../../src/model/caveats.js';

const expect = chai.expect;

const DEFS: ReadonlyMap<string, CaveatDef> = new Map(
  Object.entries<CaveatDef>({
    office_ip: { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: '10.0.0.1' } },
    not_expired: { params: { 'env.day': 'int', 'env.until': 'int' }, expr: { attr: 'env.day', lt: { ref: 'env.until' } } },
    level: { params: { 'principal.attributes.level': 'int' }, expr: { attr: 'principal.attributes.level', gte: 3 } },
    before: { params: { 'env.now': 'timestamp', 'env.until_at': 'timestamp' }, expr: { attr: 'env.now', lt: { ref: 'env.until_at' } } },
  }),
);

describe('authz-rebac: caveat evaluation', () => {
  const caveats = new RebacCaveats(DEFS);
  const ctx = fakeEvaluationContext({ conditions: new DefaultConditionCompiler(), now: new Date('2026-11-06T12:00:00Z') });
  const req = (env: Record<string, unknown>, attributes: Record<string, unknown> = {}) => ({ principal: userPrincipal('bob', { attributes }), permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, env });
  const truth = async (caveat: Parameters<RebacCaveats['evaluate']>[0], r = req({})) => (await caveats.evaluate(caveat, r, ctx)).truth;

  it('allow, deny and unknown (missing env), from the request env', async () => {
    expect(await truth({ name: 'office_ip' }, req({ ip: '10.0.0.1' }))).to.equal('allow');
    expect(await truth({ name: 'office_ip' }, req({ ip: '10.0.0.2' }))).to.equal('deny');
    expect(await truth({ name: 'office_ip' }, req({}))).to.equal('unknown');
  });

  it('the tuple context wins over the request', async () => {
    expect(await truth({ name: 'not_expired', context: { 'env.until': 20 } }, req({ day: 10, until: 5 }))).to.equal('allow');
    expect(await truth({ name: 'not_expired', context: { 'env.until': 20 } }, req({ day: 25 }))).to.equal('deny');
  });

  it('principal attributes, an unknown caveat, and the cacheable flag', async () => {
    expect(await truth({ name: 'level' }, req({}, { level: 4 }))).to.equal('allow');
    expect(await truth({ name: 'nope' })).to.equal('unknown');
    expect((await caveats.evaluate({ name: 'office_ip' }, req({ ip: '10.0.0.1' }), ctx)).cacheable).to.equal(false);
  });

  it('a timestamp in the tuple context compares with env.now', async () => {
    expect(await truth({ name: 'before', context: { 'env.until_at': '2026-12-01T00:00:00Z' } })).to.equal('allow');
    expect(await truth({ name: 'before', context: { 'env.until_at': '2026-11-01T00:00:00Z' } })).to.equal('deny');
  });

  it('a tuple context cannot move the clock', async () => {
    expect(await truth({ name: 'before', context: { 'env.now': '2020-01-01T00:00:00Z', 'env.until_at': '2026-11-01T00:00:00Z' } })).to.equal('deny');
  });

  it('overlays and picks values by parameter path', () => {
    const r = req({ ip: '10.0.0.1', ua: 'x' }, { level: 1 });
    const { principal, env } = overlayContext(r, { 'env.ip': '10.0.0.9', 'principal.attributes.level': 5, 'env.__proto__.x': 1 });
    expect(env).to.deep.equal({ ip: '10.0.0.9', ua: 'x' });
    expect(principal.attributes).to.deep.equal({ level: 5 });
    expect(principal.id).to.equal('bob');
    expect(r.env).to.deep.equal({ ip: '10.0.0.1', ua: 'x' });
    expect(pickCaveatInput(['env.ip', 'env.now', 'env.day', 'principal.attributes.level'], r)).to.deep.equal({ 'env.ip': '10.0.0.1', 'principal.attributes.level': 1 });
    expect(caveats.paramsOf(['not_expired', 'office_ip', 'nope'])).to.deep.equal(['env.day', 'env.ip', 'env.until']);
  });
});
