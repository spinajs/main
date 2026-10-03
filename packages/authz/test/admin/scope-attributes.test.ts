import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzConfigError, AuthzContributor, ConfigScopeAttributeSchemas, GLOBAL, MemoryAuthzAdminBackend, MemoryScopeAttributeStore, SCOPE_ATTRIBUTE_LIMITS, SYSTEM, ScopeAttributeReader, ScopeAttributeStore, WritableScopeAttributeStore, flattenAttributes, unflattenAttributes } from '@spinajs/authz';
import type { AuthzAdminQuery, AuthzCommand, AuthzCommandResult, AuthzTx, ResourceRef, ScopeAttributeSchema } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, instance, rejection, resetHost, setConfig, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const p1: ResourceRef = { type: 'project', id: 'p1' };
const p2: ResourceRef = { type: 'project', id: 'p2' };
const d1: ResourceRef = { type: 'doc', id: 'd1' };
const ALICE = { type: 'user', id: 'alice' };

const PROJECT_SCHEMA = {
  type: 'object',
  properties: {
    policies: {
      type: 'object',
      properties: { public_links: { type: 'boolean' }, level: { type: 'string', enum: ['bronze', 'silver', 'gold'] }, limit: { type: 'number' }, nested: { type: 'object' } },
      required: ['level'],
      additionalProperties: false,
    },
    tags: { type: 'object' },
  },
  additionalProperties: false,
};

function failure(e: unknown): AuthzAdminFailure {
  expect(e).to.be.instanceOf(AuthzAdminFailure);
  return e as AuthzAdminFailure;
}

function refusal(fn: () => unknown): AuthzAdminFailure {
  try {
    fn();
  } catch (e) {
    return failure(e);
  }
  throw new Error('expected a refusal');
}

const failed = (r: readonly AuthzCommandResult[], index = 0): { code: string; field?: string } => {
  const res = r[index];
  expect(res?.ok, JSON.stringify(r)).to.equal(false);
  return (res as Extract<AuthzCommandResult, { ok: false }>).error;
};

/** A transaction of a throwaway memory backend; `fail` rolls it back after fn. */
async function inTx(fn: (tx: AuthzTx) => Promise<unknown>, fail = false): Promise<void> {
  const backend = new MemoryAuthzAdminBackend();
  try {
    await backend.transaction('test', async (tx) => {
      await fn(tx);
      if (fail) throw new Error('roll back');
    });
  } catch (e) {
    if (!fail) throw e;
  }
}

describe('scope attribute paths', () => {
  it('flattens nested objects to dot paths of scalar leaves and back', () => {
    const value = { policies: { public_links: false, level: 'gold', limit: 3, deep: { x: -1.5 } }, flag: true };
    const { set, remove } = flattenAttributes(value);
    expect(set).to.deep.equal({ 'policies.public_links': false, 'policies.level': 'gold', 'policies.limit': 3, 'policies.deep.x': -1.5, flag: true });
    expect(remove).to.deep.equal([]);
    expect(unflattenAttributes(set)).to.deep.equal(value);
  });

  it('turns nulls into removals only when asked', () => {
    expect(flattenAttributes({ a: { b: null }, c: 1 }, { nulls: true })).to.deep.equal({ set: { c: 1 }, remove: ['a.b'] });
    const e = refusal(() => flattenAttributes({ a: { b: null } }));
    expect(e.code).to.equal('invalid_attributes');
    expect(e.field).to.equal('a.b');
  });

  it('refuses arrays and every other value, naming the path', () => {
    for (const bad of [[1], undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(0), new Map(), () => 1, 1n, Symbol('s')]) {
      const e = refusal(() => flattenAttributes({ a: { b: bad } }));
      expect(e.code).to.equal('invalid_attributes');
      expect(e.field).to.equal('a.b');
    }
  });

  it('refuses reserved keys, keys with a dot and empty keys', () => {
    for (const [obj, field] of [
      [JSON.parse('{"a":{"__proto__":{"x":1}}}'), 'a.__proto__'],
      [{ prototype: 1 }, 'prototype'],
      [{ a: { constructor: 'x' } }, 'a.constructor'],
      [{ 'a.b': 1 }, 'a.b'],
      [{ '': 1 }, ''],
    ] as const) {
      const e = refusal(() => flattenAttributes(obj, { field: 'patch' }));
      expect(e.code, JSON.stringify(obj)).to.equal('invalid_attributes');
      expect(e.field, JSON.stringify(obj)).to.equal(field === '' ? 'patch' : field);
    }
  });

  it('refuses a root that is not a plain object, naming the field', () => {
    for (const bad of [null, [], 'x', new Date(0)]) expect(refusal(() => flattenAttributes(bad, { field: 'patch' })).field).to.equal('patch');
  });

  it('holds the table limits: paths up to 160 characters, JSON values up to 1024', () => {
    const at = (n: number) => 'p'.repeat(n);
    expect(Object.keys(flattenAttributes({ [at(SCOPE_ATTRIBUTE_LIMITS.path)]: 1 }).set)).to.have.length(1);
    expect(refusal(() => flattenAttributes({ [at(SCOPE_ATTRIBUTE_LIMITS.path + 1)]: 1 })).field).to.equal(at(161));
    expect(refusal(() => flattenAttributes({ a: { [at(159)]: 1 } })).field).to.equal(`a.${at(159)}`);
    expect(flattenAttributes({ s: 'x'.repeat(1022) }).set.s).to.have.length(1022);
    expect(refusal(() => flattenAttributes({ s: 'x'.repeat(1023) })).field).to.equal('s');
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(flattenAttributes(keys(SCOPE_ATTRIBUTE_LIMITS.leaves)).set)).to.have.length(1000);
    expect(refusal(() => flattenAttributes({ t: keys(SCOPE_ATTRIBUTE_LIMITS.leaves) }, { field: 'patch' })).field).to.equal('patch');
  });

  it('refuses rows that cannot form one object', () => {
    expect(() => unflattenAttributes({ a: 1, 'a.b': 2 })).to.throw(AuthzConfigError);
    expect(() => unflattenAttributes({ 'a.__proto__.x': 1 })).to.throw(AuthzConfigError);
    expect(() => unflattenAttributes({ 'a..b': 1 })).to.throw(AuthzConfigError);
    expect(() => unflattenAttributes({ a: [1] as never })).to.throw(AuthzConfigError);
  });
});

describe('MemoryScopeAttributeStore', () => {
  it('starts from preloaded values and keeps nodes apart', async () => {
    const store = new MemoryScopeAttributeStore({
      values: [
        { scope: p1, attributes: { policies: { level: 'gold', on: true } } },
        { scope: GLOBAL, attributes: { g: 1 } },
      ],
    });
    expect(await store.get(p1)).to.deep.equal({ policies: { level: 'gold', on: true } });
    expect(await store.rows(p1)).to.deep.equal({ 'policies.level': 'gold', 'policies.on': true });
    expect(await store.get(GLOBAL)).to.deep.equal({ g: 1 });
    expect(await store.get(p2)).to.deep.equal({});
    expect(() => new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: [1] } }] })).to.throw(AuthzConfigError);
  });

  it('returns copies', async () => {
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: { b: 1 } } }] });
    ((await store.get(p1)) as { a: { b: number } }).a.b = 2;
    ((await store.rows(p1)) as Record<string, unknown>)['a.b'] = 3;
    expect(await store.rows(p1)).to.deep.equal({ 'a.b': 1 });
  });

  it('writes: removes paths with everything below them, then sets; counts both; the version changes on every write', async () => {
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: { b: 1, c: { d: 2, e: 3 } }, ab: 4 } }] });
    const v0 = await store.version();
    let n = 0;
    await inTx(async (tx) => (n = await store.write(p1, { set: { 'a.b': 5, x: 'y' }, remove: ['a.c'] }, ALICE, tx)));
    expect(n).to.equal(4);
    expect(await store.rows(p1)).to.deep.equal({ 'a.b': 5, ab: 4, x: 'y' });
    const v1 = await store.version();
    expect(v1).to.not.equal(v0);
    await inTx((tx) => store.write(p1, { set: {}, remove: [] }, ALICE, tx));
    expect(await store.version()).to.not.equal(v1);
  });

  it('a rollback restores the rows and moves the version on, never back', async () => {
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: 1 } }] });
    const v0 = await store.version();
    let inside = '';
    await inTx(async (tx) => {
      await store.write(p1, { set: { b: 2 }, remove: ['a'] }, ALICE, tx);
      await store.write(p2, { set: { c: 3 }, remove: [] }, ALICE, tx);
      await store.forget(p1, tx);
      inside = await store.version();
    }, true);
    expect(await store.rows(p1)).to.deep.equal({ a: 1 });
    expect(await store.rows(p2)).to.deep.equal({});
    const after = await store.version();
    expect(after).to.not.equal(v0);
    expect(after).to.not.equal(inside);
    await inTx((tx) => store.write(p1, { set: { z: 1 }, remove: [] }, ALICE, tx));
    expect([v0, inside, after]).to.not.include(await store.version());
  });

  it('a set path drops the rows above and below it', async () => {
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: { b: 1, c: 2 }, x: 1 } }] });
    let n = 0;
    await inTx(async (tx) => (n = await store.write(p1, { set: { a: 5, 'x.y': 2 }, remove: [] }, ALICE, tx)));
    expect(await store.get(p1)).to.deep.equal({ a: 5, x: { y: 2 } });
    expect(n).to.equal(5);
  });

  it('forget removes every row of the node', async () => {
    const store = new MemoryScopeAttributeStore({
      values: [
        { scope: p1, attributes: { a: 1, b: { c: 2 } } },
        { scope: p2, attributes: { a: 1 } },
      ],
    });
    let n = 0;
    await inTx(async (tx) => (n = await store.forget(p1, tx)));
    expect(n).to.equal(2);
    expect(await store.rows(p1)).to.deep.equal({});
    expect(await store.rows(p2)).to.deep.equal({ a: 1 });
  });

  it('refuses a transaction that is not a memory one', async () => {
    const store = new MemoryScopeAttributeStore();
    expect(await rejection(store.write(p1, { set: { a: 1 }, remove: [] }, ALICE, { driver: {} }))).to.be.instanceOf(AuthzConfigError);
    expect(await rejection(store.forget(p1, { driver: {} }))).to.be.instanceOf(AuthzConfigError);
    expect(await store.rows(p1)).to.deep.equal({});
  });
});

describe('ConfigScopeAttributeSchemas', () => {
  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  it('contributes authz.scopes.attributes as scope attribute schemas', async () => {
    const schema = { type: 'object' };
    setConfig(['authz', 'scopes', 'attributes'], { org: { schema, defaults: { policies: { a: 1 } } }, project: { schema } });
    const out = await new ConfigScopeAttributeSchemas().contribute('any');
    expect(out.scopeAttributeSchemas).to.deep.equal([
      { scopeType: 'org', schema, defaults: { policies: { a: 1 } } },
      { scopeType: 'project', schema, defaults: {} },
    ]);
    expect(out.scopeAttributeSchemas![0].schema).to.equal(schema);
  });

  it('contributes nothing without the key', async () => {
    expect(await new ConfigScopeAttributeSchemas().contribute('any')).to.deep.equal({});
  });

  it('refuses a malformed section, naming the key', async () => {
    for (const [value, key] of [
      ['x', 'authz.scopes.attributes '],
      [{ org: 1 }, 'authz.scopes.attributes.org '],
      [{ org: { defaults: {} } }, 'authz.scopes.attributes.org.schema'],
      [{ org: { schema: {}, defaults: [] } }, 'authz.scopes.attributes.org.defaults'],
    ] as const) {
      setConfig(['authz', 'scopes', 'attributes'], value);
      const e = await rejection(Promise.resolve().then(() => new ConfigScopeAttributeSchemas().contribute('any')));
      expect(e, key).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.contain(key);
    }
  });

  it('is registered as an AuthzContributor every domain asks', async () => {
    setConfig(['authz', 'scopes', 'attributes'], { project: { schema: { type: 'object' }, defaults: { policies: { level: 'bronze' } } } });
    adminConfig();
    const d = await adminDomain();
    expect((await d.container.resolveChain(AuthzContributor)).some((c) => c instanceof ConfigScopeAttributeSchemas)).to.equal(true);
  });
});

describe('ScopeAttributeHandler', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
    setConfig(['authz', 'scopes', 'attributes'], { project: { schema: PROJECT_SCHEMA, defaults: { policies: { level: 'bronze' } } } });
  });

  interface Setup {
    readonly d: AdminDomain;
    readonly store: MemoryScopeAttributeStore;
  }

  async function setup(values: { scope: ResourceRef; attributes: Record<string, unknown> }[] = [], opts: { store?: boolean; schemas?: ScopeAttributeSchema[] } = {}): Promise<Setup> {
    const store = new MemoryScopeAttributeStore({ values });
    const d = await adminDomain('test', {
      register(c) {
        if (opts.store !== false) {
          c.register(instance(store)).as(ScopeAttributeStore);
          c.register(instance(store)).as(WritableScopeAttributeStore);
        }
        if (opts.schemas) c.register(instance({ contribute: () => ({ scopeAttributeSchemas: opts.schemas }) })).as(AuthzContributor);
      },
    });
    return { d, store };
  }

  const set = (patch: Record<string, unknown>, scope: ResourceRef = p1): AuthzCommand => ({ kind: 'scope.setAttributes', scope, patch });
  const replace = (attributes: Record<string, unknown>, scope: ResourceRef = p1): AuthzCommand => ({ kind: 'scope.replaceAttributes', scope, attributes });

  it('setAttributes merges deeply and counts the rows written', async () => {
    const { d, store } = await setup([{ scope: p1, attributes: { policies: { level: 'gold', public_links: true }, tags: { a: 'x' } } }]);
    const r = await d.admin.execute(alice, [set({ policies: { level: 'silver', limit: 5 } })]);
    expect(r).to.deep.equal([{ ok: true, kind: 'scope.setAttributes', affected: 2 }]);
    expect(await store.get(p1)).to.deep.equal({ policies: { level: 'silver', public_links: true, limit: 5 }, tags: { a: 'x' } });
  });

  it('a null removes the path and everything below it', async () => {
    const { d, store } = await setup([{ scope: p1, attributes: { policies: { level: 'gold', nested: { x: 1, y: 2 } }, tags: { a: 'x', b: 'y' } } }]);
    const r = await d.admin.execute(alice, [set({ policies: { nested: null }, tags: null })]);
    expect(r).to.deep.equal([{ ok: true, kind: 'scope.setAttributes', affected: 4 }]);
    expect(await store.rows(p1)).to.deep.equal({ 'policies.level': 'gold' });
    expect(d.sink.events.map((e) => e.data)).to.deep.equal([{ scope: p1, paths: ['policies.nested.x', 'policies.nested.y', 'tags.a', 'tags.b'] }]);
  });

  it('a scalar replaces a subtree and a subtree replaces a scalar', async () => {
    const { d, store } = await setup([{ scope: p1, attributes: { policies: { level: 'gold', nested: { x: 1 } }, tags: { a: 'x' } } }]);
    setConfig(['authz', 'scopes', 'attributes'], { project: { schema: { type: 'object' }, defaults: {} } });
    await d.admin.execute(alice, [set({ policies: { nested: 7 }, tags: { a: { deep: true } } })]);
    expect(await store.get(p1)).to.deep.equal({ policies: { level: 'gold', nested: 7 }, tags: { a: { deep: true } } });
  });

  it('replaceAttributes makes the stored rows exactly the new object', async () => {
    const { d, store } = await setup([{ scope: p1, attributes: { policies: { level: 'gold', public_links: true, limit: 1 } } }]);
    const r = await d.admin.execute(alice, [replace({ policies: { level: 'gold', limit: 2 }, tags: { t: 'v' } })]);
    // limit and tags.t written, public_links removed; level unchanged
    expect(r).to.deep.equal([{ ok: true, kind: 'scope.replaceAttributes', affected: 3 }]);
    expect(await store.get(p1)).to.deep.equal({ policies: { level: 'gold', limit: 2 }, tags: { t: 'v' } });
    expect(d.sink.events.map((e) => e.data)).to.deep.equal([{ scope: p1, paths: ['policies.limit', 'policies.public_links', 'tags.t'] }]);
  });

  it('validates defaults ⊕ stored ⊕ patch against the schema from authz.scopes.attributes', async () => {
    const { d, store } = await setup();
    // level comes from the defaults
    expect((await d.admin.execute(alice, [set({ policies: { public_links: false } })]))[0].ok).to.equal(true);
    for (const [patch, field] of [
      [{ policies: { public_links: 'sometimes' } }, 'policies.public_links'],
      [{ policies: { level: 'platinum' } }, 'policies.level'],
      [{ policies: { extra: 1 } }, 'policies.extra'],
      [{ other: 1 }, 'other'],
      [{ policies: 5 }, 'policies'],
    ] as const) {
      const r = await d.admin.execute(alice, [set(patch as Record<string, unknown>)]);
      expect(failed(r), JSON.stringify(patch)).to.deep.include({ code: 'invalid_attributes', field });
    }
    expect(await store.get(p1)).to.deep.equal({ policies: { public_links: false } });
  });

  it('the stored values count: removing a required value refused only when no default supplies it', async () => {
    const schemas: ScopeAttributeSchema[] = [{ scopeType: 'doc', schema: { type: 'object', properties: { p: { type: 'object', required: ['must'] } } }, defaults: {} }];
    const { d } = await setup([{ scope: d1, attributes: { p: { must: 1, other: 2 } } }], { schemas });
    expect((await d.admin.execute(alice, [set({ p: { other: 3 } }, d1)]))[0].ok).to.equal(true);
    expect(failed(await d.admin.execute(alice, [set({ p: { must: null } }, d1)]))).to.deep.include({ code: 'invalid_attributes', field: 'p.must' });
    expect(failed(await d.admin.execute(alice, [replace({ p: { other: 1 } }, d1)]))).to.deep.include({ code: 'invalid_attributes', field: 'p.must' });
  });

  it('takes the schema from a contributor of the domain', async () => {
    const schemas: ScopeAttributeSchema[] = [{ scopeType: 'doc', schema: { type: 'object', properties: { size: { type: 'number', maximum: 10 } } }, defaults: { size: 1 } }];
    const { d, store } = await setup([], { schemas });
    expect((await d.admin.execute(alice, [set({ size: 5 }, d1)]))[0].ok).to.equal(true);
    expect(failed(await d.admin.execute(alice, [set({ size: 11 }, d1)]))).to.deep.include({ code: 'invalid_attributes', field: 'size' });
    expect(await store.get(d1)).to.deep.equal({ size: 5 });
  });

  it('refuses a scope type without a schema, GLOBAL and a type-level scope', async () => {
    const { d } = await setup();
    expect(failed(await d.admin.execute(alice, [set({ a: 1 }, d1)]))).to.deep.include({ code: 'invalid_attributes', field: 'scope' });
    expect(failed(await d.admin.execute(SYSTEM, [set({ a: 1 }, GLOBAL)]))).to.deep.include({ code: 'invalid_attributes', field: 'scope' });
    expect(failed(await d.admin.execute(SYSTEM, [replace({ a: 1 }, { type: 'project' })]))).to.deep.include({ code: 'invalid_attributes', field: 'scope' });
  });

  it('refuses values the table cannot hold, naming the path', async () => {
    const { d } = await setup();
    expect(failed(await d.admin.execute(alice, [set({ tags: { list: ['a'] } })]))).to.deep.include({ code: 'invalid_attributes', field: 'tags.list' });
    expect(failed(await d.admin.execute(alice, [set({ tags: { 'a.b': 1 } })]))).to.deep.include({ code: 'invalid_attributes', field: 'tags.a.b' });
    expect(failed(await d.admin.execute(alice, [set('x' as never)]))).to.deep.include({ code: 'invalid_attributes', field: 'patch' });
    expect(failed(await d.admin.execute(alice, [replace({ tags: { a: null } })]))).to.deep.include({ code: 'invalid_attributes', field: 'tags.a' });
  });

  it('rejects with AuthzConfigError when no WritableScopeAttributeStore is registered', async () => {
    const { d } = await setup([], { store: false });
    expect(await rejection(d.admin.execute(alice, [set({ policies: { level: 'gold' } })]))).to.be.instanceOf(AuthzConfigError);
  });

  it('rejects with AuthzConfigError for a schema with an unknown keyword or format', async () => {
    for (const schema of [
      { type: 'object', requried: ['a'] },
      { type: 'object', properties: { a: { type: 'string', format: 'email' } } },
    ]) {
      await resetHost();
      adminConfig();
      const { d } = await setup([], { schemas: [{ scopeType: 'doc', schema, defaults: {} }] });
      expect(await rejection(d.admin.execute(alice, [set({ a: 'x' }, d1)])), JSON.stringify(schema)).to.be.instanceOf(AuthzConfigError);
    }
  });

  it('refuses a scope type or id longer than 64 characters and a node over the leaf cap', async () => {
    const many = Object.fromEntries(Array.from({ length: 999 }, (_, i) => [`k${i}`, i]));
    const { d, store } = await setup([{ scope: d1, attributes: { t: many } }], { schemas: [{ scopeType: 'doc', schema: { type: 'object' }, defaults: {} }] });
    expect(failed(await d.admin.execute(SYSTEM, [set({ a: 1 }, { type: 'doc', id: 'i'.repeat(65) })]))).to.deep.include({ code: 'invalid_attributes', field: 'scope' });
    expect(failed(await d.admin.execute(SYSTEM, [set({ a: 1 }, { type: 't'.repeat(65), id: 'x' })]))).to.deep.include({ code: 'invalid_attributes', field: 'scope' });
    expect((await d.admin.execute(alice, [set({ u: 1 }, d1)]))[0].ok).to.equal(true);
    expect(failed(await d.admin.execute(alice, [set({ v: 1 }, d1)]))).to.deep.include({ code: 'invalid_attributes', field: 'patch' });
    expect(failed(await d.admin.execute(alice, [replace({ ...many, a: 1, b: 2 }, d1)]))).to.deep.include({ code: 'invalid_attributes', field: 'attributes' });
    expect(Object.keys(await store.rows(d1))).to.have.length(1000);
  });

  it('rejects with AuthzConfigError for a schema that does not compile', async () => {
    const { d } = await setup([], { schemas: [{ scopeType: 'doc', schema: { type: 'nonsense' }, defaults: {} }] });
    expect(await rejection(d.admin.execute(alice, [set({ a: 1 }, d1)]))).to.be.instanceOf(AuthzConfigError);
  });

  it('needs authz:scope.manage at the scope, which authz.admin.permissions may map', async () => {
    const { d, store } = await setup();
    expect(failed(await d.admin.execute(bob, [set({ policies: { level: 'gold' } })]))).to.deep.include({ code: 'forbidden' });
    expect(await store.rows(p1)).to.deep.equal({});
    expect(d.audit.entries.filter((e) => e.kind === 'admin')).to.deep.equal([]);
    await d.admin.execute(alice, [set({ policies: { level: 'gold' } })]);
    const admin = d.audit.entries.filter((e) => e.kind === 'admin');
    expect(admin.map((e) => [e.permission, e.resource])).to.deep.equal([['authz:scope.manage', p1]]);
    adminConfig({ permissions: { 'scope.*': { project: 'app:settings.manage' } } });
    await d.admin.execute(alice, [set({ policies: { level: 'silver' } })]);
    expect(d.audit.entries.filter((e) => e.kind === 'admin').map((e) => e.permission)).to.deep.equal(['authz:scope.manage', 'app:settings.manage']);
  });

  it('publishes scope:<type>:<id> and a ScopeAttributesChanged event', async () => {
    const { d } = await setup([{ scope: p1, attributes: { policies: { level: 'gold' } } }]);
    await d.admin.execute(alice, [set({ policies: { level: 'silver', public_links: true } }), set({ policies: { level: 'gold' } }, p2)]);
    expect(d.bus.published.at(-1)?.tags).to.deep.equal(['scope:project:p1', 'scope:project:p2']);
    expect(d.sink.events.map((e) => ({ type: e.type, domain: e.domain, actor: e.actor, data: e.data }))).to.deep.equal([
      { type: 'ScopeAttributesChanged', domain: 'test', actor: ALICE, data: { scope: p1, paths: ['policies.level', 'policies.public_links'] } },
      { type: 'ScopeAttributesChanged', domain: 'test', actor: ALICE, data: { scope: p2, paths: ['policies.level'] } },
    ]);
  });

  it('a failed or rejected batch, and a dry run, leave the store unchanged', async () => {
    const { d, store } = await setup([{ scope: p1, attributes: { policies: { level: 'gold' } } }]);
    const v0 = await store.version();
    const grant = (role: string): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: 'bob' }, role, scope: p1 });
    expect(failed(await d.admin.execute(alice, [set({ policies: { level: 'silver' } }), grant('clash')]), 1).code).to.equal('conflict');
    expect(await rejection(d.admin.execute(alice, [replace({ policies: { level: 'silver' } }), grant('boom')]))).to.be.an('error');
    const dry = await d.admin.execute(alice, [set({ policies: { level: 'silver', limit: 1 } })], { dryRun: true });
    expect(dry).to.deep.equal([{ ok: true, kind: 'scope.setAttributes', affected: 2 }]);
    expect(await store.rows(p1)).to.deep.equal({ 'policies.level': 'gold' });
    // the memory store moves its version on after a rollback (it never reuses one)
    expect(await store.version()).to.not.equal(v0);
    expect(d.sink.events).to.deep.equal([]);
  });

  it('validates each command against the rows the batch left so far', async () => {
    const schemas: ScopeAttributeSchema[] = [{ scopeType: 'doc', schema: { type: 'object', maxProperties: 1 }, defaults: {} }];
    const { d, store } = await setup([], { schemas });
    const r = await d.admin.execute(alice, [set({ a: 1 }, d1), set({ b: 1 }, d1)]);
    expect(failed(r, 1)).to.deep.include({ code: 'invalid_attributes' });
    expect(await store.rows(d1)).to.deep.equal({});
  });

  it('an unchanged value writes nothing and announces nothing', async () => {
    const { d, store } = await setup([{ scope: p1, attributes: { policies: { level: 'gold' } } }]);
    const v0 = await store.version();
    expect(await d.admin.execute(alice, [set({ policies: { level: 'gold' } })])).to.deep.equal([{ ok: true, kind: 'scope.setAttributes', affected: 0 }]);
    expect(await store.version()).to.equal(v0);
    expect(d.bus.published.at(-1)?.tags).to.deep.equal([]);
    expect(d.sink.events).to.deep.equal([]);
  });

  it('setScopeAttributes is the sugar for one setAttributes', async () => {
    const { d, store } = await setup();
    await d.admin.setScopeAttributes(alice, p1, { policies: { level: 'gold' } });
    expect(await store.get(p1)).to.deep.equal({ policies: { level: 'gold' } });
    const e = failure(await rejection(d.admin.setScopeAttributes(alice, p1, { policies: { level: 1 } })));
    expect(e.code).to.equal('invalid_attributes');
    expect(e.field).to.equal('policies.level');
  });
});

describe('the attributes reader', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
    setConfig(['authz', 'scopes', 'attributes'], { project: { schema: PROJECT_SCHEMA, defaults: { policies: { level: 'bronze' } } } });
  });

  it('lists the stored object of the scope, without defaults', async () => {
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { policies: { public_links: true } } }] });
    const d = await adminDomain('test', { register: (c) => c.register(instance(store)).as(ScopeAttributeStore) });
    expect(await d.admin.list(alice, { kind: 'attributes', scope: p1 })).to.deep.equal({ items: [{ policies: { public_links: true } }], total: 1 });
    expect(await d.admin.list(alice, { kind: 'attributes', scope: p2 })).to.deep.equal({ items: [{}], total: 1 });
    expect(failure(await rejection(d.admin.list(bob, { kind: 'attributes', scope: p1 }))).code).to.equal('forbidden');
  });

  it('answers an empty object without a store', async () => {
    const d = await adminDomain();
    expect(await d.admin.list(alice, { kind: 'attributes', scope: p1 })).to.deep.equal({ items: [{}], total: 1 });
  });

  it('refuses a query without a scope', async () => {
    const d = await adminDomain();
    const reader = new ScopeAttributeReader();
    const ctx = { domain: 'test', now: new Date(), authz: d.service, actor: alice, container: d.container, dryRun: false };
    for (const scope of [undefined, null, {}, { type: '' }]) {
      const e = failure(await rejection(reader.list({ kind: 'attributes', scope } as unknown as AuthzAdminQuery, ctx)));
      expect(e.code).to.equal('invalid_query');
      expect(e.field).to.equal('scope');
    }
  });
});
