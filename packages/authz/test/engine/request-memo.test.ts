import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { FALSE, GLOBAL, TRUE } from '../../src/index.js';
import type { Decision, ResourceRef } from '../../src/index.js';
import { FakeAdapter, FakeRow, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const alice = principal('user', 'alice');
const F1: ResourceRef = { type: 'folder', id: 'f1' };
const D1: ResourceRef = { type: 'doc', id: 'd1' };
const OVERLAPPING = 10;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Ancestor and scope attribute reads that wait while `held` and fail while `failing`. */
class GatedAdapter extends FakeAdapter {
  held = false;
  failing = false;
  private readonly waiting: (() => void)[] = [];

  constructor() {
    super(['doc', 'folder'], { rows: [new FakeRow('doc', 'd1', {}, F1), new FakeRow('folder', 'f1')], scopeAttributes: { 'folder:f1': { tier: 'gold' } } });
  }

  override async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    const list = await super.ancestors(ref);
    await this.gate();
    return list;
  }

  override async scopeAttributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    const attributes = await super.scopeAttributes(ref);
    await this.gate();
    return attributes;
  }

  release(): void {
    this.held = false;
    for (const go of this.waiting.splice(0)) go();
  }

  private async gate(): Promise<void> {
    if (this.held) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.failing) throw new Error('store down');
  }
}

/** Starts `n` checks at once and lets their reads answer only after every one of them asked. */
async function overlapping(adapter: GatedAdapter, n: number, check: () => Promise<Decision>, asked: () => number): Promise<Decision[]> {
  adapter.held = true;
  const all = Promise.all(Array.from({ length: n }, check));
  for (let i = 0; i < 50 && asked() < n; i++) await tick();
  adapter.release();
  return all;
}

/** A model whose vote rests on the scope attributes of F1; uncacheable, so every check asks for them. */
const attributeReader = (): StaticModel =>
  new StaticModel('m', {
    capabilities: { sync: 'never' },
    vote: async (_req, ctx) => ({ model: 'm', permitWhen: (await ctx.attributes(F1)) === null ? FALSE : TRUE, denyWhen: FALSE, cacheable: false }),
  });

const authorizer = (adapter: GatedAdapter, models: StaticModel[] = []): Authorizer =>
  new Authorizer({ domain: 'root', registry: registryOf([{ name: 'doc:read', types: ['doc'] }]), models, adapters: [adapter], clock: fakeClock().clock, log: new RecordingLog() });

describe('engine request memo (L1): a read is shared once settled, never while it runs', () => {
  describe('ancestors', () => {
    it('overlapping first reads of one ref read each; a check after they settled reads none', async () => {
      const adapter = new GatedAdapter();
      const a = authorizer(adapter);
      const scope = { cache: new Map<string, unknown>() };
      await overlapping(adapter, OVERLAPPING, () => a.check({ principal: alice, permission: 'doc:read', resource: D1 }, scope), () => adapter.ancestorCalls.length);
      expect(adapter.ancestorCalls).to.have.length(OVERLAPPING);
      await a.check({ principal: alice, permission: 'doc:read', resource: D1 }, scope);
      expect(await a.ancestors(D1, scope)).to.deep.equal([D1, F1, GLOBAL]);
      expect(adapter.ancestorCalls).to.have.length(OVERLAPPING);
    });

    it('a failed read is not kept: the next check of the request reads again', async () => {
      const adapter = new GatedAdapter();
      const a = authorizer(adapter);
      const scope = { cache: new Map<string, unknown>() };
      adapter.failing = true;
      await a.ancestors(D1, scope).catch(() => undefined);
      adapter.failing = false;
      expect(await a.ancestors(D1, scope)).to.deep.equal([D1, F1, GLOBAL]);
      expect(adapter.ancestorCalls).to.have.length(2);
    });

    it('a read that settles after an invalidate is not kept, and one kept before an invalidate is not served after it', async () => {
      const adapter = new GatedAdapter();
      const a = authorizer(adapter);
      const scope = { cache: new Map<string, unknown>() };
      adapter.held = true;
      const first = a.ancestors(D1, scope);
      for (let i = 0; i < 50 && adapter.ancestorCalls.length === 0; i++) await tick();
      a.invalidate(['scope:folder:f1']);
      adapter.release();
      await first;
      await a.ancestors(D1, scope);
      expect(adapter.ancestorCalls).to.have.length(2);
      await a.ancestors(D1, scope);
      expect(adapter.ancestorCalls).to.have.length(2);
      a.invalidate(['scope:folder:f1']);
      await a.ancestors(D1, scope);
      expect(adapter.ancestorCalls).to.have.length(3);
    });
  });

  describe('scope attributes', () => {
    it('overlapping first reads of one node read each; a check after they settled reads none', async () => {
      const adapter = new GatedAdapter();
      const a = authorizer(adapter, [attributeReader()]);
      const scope = { cache: new Map<string, unknown>() };
      const decisions = await overlapping(adapter, OVERLAPPING, () => a.check({ principal: alice, permission: 'doc:read' }, scope), () => adapter.attributeCalls.length);
      expect(decisions.every((d) => d.allowed)).to.equal(true);
      expect(adapter.attributeCalls).to.have.length(OVERLAPPING);
      expect((await a.check({ principal: alice, permission: 'doc:read' }, scope)).allowed).to.equal(true);
      expect(adapter.attributeCalls).to.have.length(OVERLAPPING);
    });

    it('a failed read is not kept: the next check of the request reads again', async () => {
      const adapter = new GatedAdapter();
      const a = authorizer(adapter, [attributeReader()]);
      const scope = { cache: new Map<string, unknown>() };
      adapter.failing = true;
      expect((await a.check({ principal: alice, permission: 'doc:read' }, scope)).allowed).to.equal(false);
      adapter.failing = false;
      expect((await a.check({ principal: alice, permission: 'doc:read' }, scope)).allowed).to.equal(true);
      expect(adapter.attributeCalls).to.have.length(2);
    });

    it('a read that settles after an invalidate is not kept, and one kept before an invalidate is not served after it', async () => {
      const adapter = new GatedAdapter();
      const a = authorizer(adapter, [attributeReader()]);
      const scope = { cache: new Map<string, unknown>() };
      adapter.held = true;
      const first = a.check({ principal: alice, permission: 'doc:read' }, scope);
      for (let i = 0; i < 50 && adapter.attributeCalls.length === 0; i++) await tick();
      a.invalidate(['scope:folder:f1']);
      adapter.release();
      await first;
      await a.check({ principal: alice, permission: 'doc:read' }, scope);
      expect(adapter.attributeCalls).to.have.length(2);
      await a.check({ principal: alice, permission: 'doc:read' }, scope);
      expect(adapter.attributeCalls).to.have.length(2);
      a.invalidate(['scope:folder:f1']);
      await a.check({ principal: alice, permission: 'doc:read' }, scope);
      expect(adapter.attributeCalls).to.have.length(3);
    });
  });
});
