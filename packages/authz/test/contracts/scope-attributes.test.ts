import * as chai from 'chai';
import 'mocha';

import * as authz from '../../src/index.js';
import { CORE_FILTER_OPS, ScopeAttributeStore } from '../../src/index.js';
import type { FilterOp, ResourceRef, ResourceType, ScopeAttributeSchema } from '../../src/index.js';

const expect = chai.expect;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <_T extends true>(): void => {};

class FakeStore extends ScopeAttributeStore {
  public async get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    return { policies: { public_links: ref.id === 'o1' } };
  }
  public async version(): Promise<string> {
    return 'v1';
  }
}

describe('scope attribute contracts', () => {
  it('ScopeAttributeSchema has exactly the §5.6 members', () => {
    yes<Equal<ScopeAttributeSchema, { readonly scopeType: ResourceType; readonly schema: object; readonly defaults: Readonly<Record<string, unknown>> }>>();
    const s: ScopeAttributeSchema = { scopeType: 'org', schema: { type: 'object' }, defaults: { policies: { public_links: true } } };
    // @ts-expect-error defaults is required
    const bad: ScopeAttributeSchema = { scopeType: 'org', schema: {} };
    expect([s, bad]).to.have.length(2);
  });

  it('ScopeAttributeStore public shape and a fake store', async () => {
    yes<Equal<Pick<ScopeAttributeStore, keyof ScopeAttributeStore>, { get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>>; version(): Promise<string> }>>();
    const store: ScopeAttributeStore = new FakeStore();
    expect(await store.get({ type: 'org', id: 'o1' })).to.deep.equal({ policies: { public_links: true } });
    expect(await store.version()).to.equal('v1');
  });

  it('is exported from the root', () => {
    expect((authz as Record<string, unknown>).ScopeAttributeStore).to.equal(ScopeAttributeStore);
  });
});

describe('CORE_FILTER_OPS', () => {
  it('lists the non-native ops, frozen, exported from the root', () => {
    expect(CORE_FILTER_OPS).to.deep.equal(['true', 'false', 'and', 'or', 'not', 'relation', 'under', 'cmp']);
    expect(Object.isFrozen(CORE_FILTER_OPS)).to.equal(true);
    expect((authz as Record<string, unknown>).CORE_FILTER_OPS).to.equal(CORE_FILTER_OPS);
    yes<Equal<typeof CORE_FILTER_OPS, readonly FilterOp[]>>();
    const valid: readonly string[] = ['true', 'false', 'and', 'or', 'not', 'cmp', 'relation', 'under'];
    for (const op of CORE_FILTER_OPS) expect(valid).to.include(op);
  });
});
