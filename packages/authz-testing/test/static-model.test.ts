import { expect } from 'chai';
import 'mocha';

import { AuthorizationModel, CORE_FILTER_OPS, FALSE, TRUE } from '@spinajs/authz';
import type { DecisionRequest, PermissionDef, ResourceFilter, Vote } from '@spinajs/authz';

import { FakePermissionRegistry, StaticModel, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '../src/index.js';

const alice = userPrincipal('alice');
const req = (permission: string, id?: string, type = 'file'): DecisionRequest => ({ principal: alice, permission, resource: id === undefined ? { type } : { type, id } });
const reg = new FakePermissionRegistry(['file:read', 'file:write', 'user:read', { name: 'doc:read', types: ['doc', 'file'] }]);
const def = (name: string): PermissionDef => reg.require(name);

describe('StaticModel', () => {
  it('is an AuthorizationModel with permissive defaults: no opinion, every route, core ops', async () => {
    const m = new StaticModel();
    expect(m).to.be.instanceOf(AuthorizationModel);
    expect(m.name).to.eq('static');
    expect(m.capabilities).to.deep.eq({ effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'always', fields: false, needsSubject: false });
    expect(m.applies(def('file:read'), 'file')).to.eq(true);
    expect(await m.evaluate(req('file:read', 'f1'), fakeEvaluationContext())).to.deep.eq({ model: 'static', permitWhen: FALSE, denyWhen: FALSE, cacheable: true });
  });

  it('answers synchronously unless delayed or scripted with a promise (sync: always holds)', () => {
    expect(new StaticModel().evaluate(req('file:read'), fakeEvaluationContext())).to.not.be.instanceOf(Promise);
    expect(new StaticModel({ votes: async () => ({}) }).evaluate(req('file:read'), fakeEvaluationContext())).to.be.instanceOf(Promise);
  });

  it('returns exactly the scripted vote, filling only model, permitWhen, denyWhen and cacheable', async () => {
    const permitWhen: ResourceFilter = { op: 'relation', relation: 'owner' };
    const denies = [{ when: TRUE, reason: { code: 'blocked', priority: 100, sortKey: 'b' } }];
    const m = new StaticModel({ name: 'abac', votes: { 'file:read': { permitWhen, fields: { read: ['a'] }, validUntil: new Date(5) }, 'file:write': { denies, cacheable: false } } });
    const v1 = (await m.evaluate(req('file:read', 'f1'), fakeEvaluationContext())) as Vote;
    expect(v1).to.deep.eq({ model: 'abac', permitWhen, denyWhen: FALSE, cacheable: true, fields: { read: ['a'] }, validUntil: new Date(5) });
    expect(v1.permitWhen).to.eq(permitWhen);
    const v2 = (await m.evaluate(req('file:write', 'f1'), fakeEvaluationContext())) as Vote;
    // denyWhen omitted next to denies: filled with the OR of their whens, so the vote stays consistent
    expect(v2).to.deep.eq({ model: 'abac', permitWhen: FALSE, denyWhen: TRUE, denies, cacheable: false });
  });

  it('a fully scripted vote comes back unchanged, including a foreign model name', async () => {
    const vote: Vote = { model: 'other', permitWhen: TRUE, denyWhen: FALSE, reason: { code: 'x' }, error: 'boom', cacheable: false };
    const m = new StaticModel({ votes: () => vote });
    expect(await m.evaluate(req('file:read', 'f1'), fakeEvaluationContext())).to.deep.eq(vote);
  });

  it('table lookup: permission@resource, then permission@type, then permission, then *', async () => {
    const m = new StaticModel({
      votes: {
        'file:read@file:f1': { reason: { code: 'exact' } },
        'file:read@file': { reason: { code: 'type' } },
        'file:read': { reason: { code: 'perm' } },
        '*': { reason: { code: 'any' } },
      },
    });
    const code = async (r: DecisionRequest) => ((await m.evaluate(r, fakeEvaluationContext())) as Vote).reason?.code;
    expect(await code(req('file:read', 'f1'))).to.eq('exact');
    expect(await code(req('file:read', 'f2'))).to.eq('type');
    expect(await code(req('file:read'))).to.eq('type');
    expect(await code(req('file:read', 'x', 'doc'))).to.eq('perm');
    expect(await code(req('user:read', 'u1', 'user'))).to.eq('any');
  });

  it('a vote function sees the request and the context', async () => {
    const ctx = fakeEvaluationContext({ domain: 'd' });
    const m = new StaticModel({ votes: (r, c) => ({ permitWhen: r.resource.id === 'f1' && c.domain === 'd' ? TRUE : FALSE }) });
    expect(((await m.evaluate(req('file:read', 'f1'), ctx)) as Vote).permitWhen).to.eq(TRUE);
    expect(((await m.evaluate(req('file:read', 'f2'), ctx)) as Vote).permitWhen).to.eq(FALSE);
  });

  it('routes by permission globs and types, or by a function', () => {
    const m = new StaticModel({ applies: { permissions: ['file:*'], types: ['file'] } });
    expect(m.applies(def('file:read'), 'file')).to.eq(true);
    expect(m.applies(def('user:read'), 'user')).to.eq(false);
    expect(m.applies(def('doc:read'), 'file')).to.eq(false);
    expect(m.capabilities.resourceTypes).to.deep.eq(['file']);
    const f = new StaticModel({ applies: (d, t) => d.name === 'doc:read' && t === 'doc' });
    expect(f.applies(def('doc:read'), 'doc')).to.eq(true);
    expect(f.applies(def('doc:read'), 'file')).to.eq(false);
  });

  it('error, throw and delay', async () => {
    const ctx = fakeEvaluationContext();
    const failing = new StaticModel({ error: 'store down' });
    expect(await failing.evaluate(req('file:read', 'f1'), ctx)).to.deep.eq({ model: 'static', permitWhen: FALSE, denyWhen: FALSE, cacheable: true, error: 'store down' });

    const boom = new Error('boom');
    const throwing = new StaticModel({ throws: boom });
    let caught: unknown;
    try {
      await throwing.evaluate(req('file:read', 'f1'), ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.eq(boom);

    const slow = new StaticModel({ delayMs: 30 });
    const t0 = Date.now();
    await slow.evaluate(req('file:read', 'f1'), ctx);
    expect(Date.now() - t0).to.be.at.least(25);

    const hanging = new StaticModel({ delayMs: Infinity });
    const settled = await Promise.race([Promise.resolve(hanging.evaluate(req('file:read', 'f1'), ctx)).then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).to.eq('pending');
  });

  it('records calls and supports summarize, invalidate, version, respond', async () => {
    const m = new StaticModel({ summary: { permissions: [{ name: 'file:read', conditional: false }] } });
    const ctx = fakeEvaluationContext();
    const init = fakeModelInitContext();
    await m.init(init);
    await m.evaluate(req('file:read', 'f1'), ctx);
    expect(await m.summarize!(alice, { type: '$global' }, ctx)).to.deep.eq({ model: 'static', permissions: [{ name: 'file:read', conditional: false }] });
    m.invalidate!(['role:x']);
    expect(m.calls.map((c) => c.method)).to.deep.eq(['init', 'evaluate', 'summarize', 'invalidate']);
    expect(m.requests).to.deep.eq([req('file:read', 'f1')]);
    expect(m.invalidations).to.deep.eq([['role:x']]);

    const v0 = m.version!();
    m.bump();
    expect(m.version!()).to.not.eq(v0);

    m.respond({ 'file:read': { permitWhen: TRUE } });
    expect(((await m.evaluate(req('file:read', 'f1'), ctx)) as Vote).permitWhen).to.eq(TRUE);
  });

  it('capabilities can be overridden', () => {
    const m = new StaticModel({ capabilities: { effects: ['permit'], sync: 'never' } });
    expect(m.capabilities.effects).to.deep.eq(['permit']);
    expect(m.capabilities.sync).to.eq('never');
    expect(m.capabilities.residuals).to.eq(CORE_FILTER_OPS);
  });
});
