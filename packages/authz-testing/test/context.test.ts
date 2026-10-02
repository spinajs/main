import { expect } from 'chai';
import 'mocha';

import { ConditionCompiler, GLOBAL, NativeFilter, PermissionRegistry, ResourceAdapter, ScopeResolver } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

import { FakeAdapter, FakeRelationResolver, FakeScopeResolver, ManualClock, fakeEvaluationContext, fakeModelInitContext } from '../src/index.js';

const file: ResourceRef = { type: 'file', id: 'f1' };

describe('fakeEvaluationContext', () => {
  it('defaults: domain root, an empty registry, unregistered types get [ref, GLOBAL] and {}', async () => {
    const ctx = fakeEvaluationContext();
    expect(ctx.domain).to.eq('root');
    expect(ctx.permissions).to.be.instanceOf(PermissionRegistry);
    expect(ctx.permissions.all()).to.deep.eq([]);
    expect(await ctx.ancestors(file)).to.deep.eq([file, GLOBAL]);
    expect(await ctx.ancestors(GLOBAL)).to.deep.eq([GLOBAL]);
    expect(await ctx.attributes(file)).to.deep.eq({});
    expect(ctx.cache).to.be.instanceOf(Map);
    expect(ctx.relation('file', 'owner')).to.eq(undefined);
  });

  it('the conditions compiler and check delegate throw by default', async () => {
    const ctx = fakeEvaluationContext();
    expect(ctx.conditions).to.be.instanceOf(ConditionCompiler);
    let err: Error | undefined;
    try {
      await ctx.conditions.compile({ attr: 'env.x', eq: 1 }, { principal: undefined!, permission: 'a:b', resource: file }, ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.match(/no condition compiler in this fake/);
    err = undefined;
    try {
      await ctx.check({ principal: undefined!, permission: 'a:b', resource: file });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.match(/no check delegate/);
  });

  it('the default conditions compiler rejects; it does not throw synchronously', async () => {
    const ctx = fakeEvaluationContext();
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = ctx.conditions.compile({ attr: 'env.x', eq: 1 }, { principal: undefined!, permission: 'a:b', resource: file }, ctx);
    }).to.not.throw();
    expect(pending).to.be.instanceOf(Promise);
    const err = await pending!.then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).to.match(/no condition compiler in this fake/);
  });

  it('takes permissions as names or a registry, now from a Date or a clock', () => {
    const clock = new ManualClock(new Date('2026-01-01T00:00:00Z'));
    expect(fakeEvaluationContext({ permissions: ['file:read'] }).permissions.get('file:read')).to.not.eq(undefined);
    expect(fakeEvaluationContext({ now: clock }).now).to.deep.eq(new Date('2026-01-01T00:00:00Z'));
    expect(fakeEvaluationContext({ now: new Date(5) }).now).to.deep.eq(new Date(5));
  });

  it('reads ancestors and attributes from adapters, then scope resolvers', async () => {
    const adapter = new FakeAdapter({ types: ['file'], rows: { file: [{ id: 'f1' }] }, parents: [[file, { type: 'project', id: 'p1' }]] });
    const scopes = new FakeScopeResolver({ nodes: [{ ref: { type: 'project', id: 'p1' }, attributes: { name: 'P' } }] });
    const ctx = fakeEvaluationContext({ adapters: [adapter], scopeResolvers: [scopes] });
    expect(adapter).to.be.instanceOf(ResourceAdapter);
    expect(scopes).to.be.instanceOf(ScopeResolver);
    expect(await ctx.ancestors(file)).to.deep.eq([file, { type: 'project', id: 'p1' }, GLOBAL]);
    expect(await ctx.ancestors({ type: 'file', id: 'nope' })).to.eq(null);
    expect(await ctx.ancestors({ type: 'project', id: 'p1' })).to.deep.eq([{ type: 'project', id: 'p1' }, GLOBAL]);
    expect(await ctx.attributes({ type: 'project', id: 'p1' })).to.deep.eq({ name: 'P' });
    expect(await ctx.attributes(file)).to.deep.eq({});
  });

  it('memoises ancestors and attributes per context and counts the loads', async () => {
    let loads = 0;
    class Counting extends ScopeResolver {
      readonly types = ['org'];
      async ancestors(ref: ResourceRef) {
        loads++;
        return [ref, GLOBAL];
      }
      async attributes() {
        loads++;
        return { a: 1 };
      }
    }
    const ctx = fakeEvaluationContext({ scopeResolvers: [new Counting()] });
    const org = { type: 'org', id: 'o1' };
    await Promise.all([ctx.ancestors(org), ctx.ancestors(org), ctx.ancestors({ type: 'org', id: 'o1' })]);
    await ctx.attributes(org);
    await ctx.attributes(org);
    expect(loads).to.eq(2);
    expect(ctx.stats.ancestors).to.deep.eq({ calls: 3, loads: 1, keys: ['org:o1'] });
    expect(ctx.stats.attributes).to.deep.eq({ calls: 2, loads: 1, keys: ['org:o1'] });
    expect(fakeEvaluationContext({ scopeResolvers: [new Counting()] }).stats.ancestors.loads).to.eq(0);
  });

  it('records trace steps, finds relations (explicit first, then adapters) and native filters', () => {
    class N extends NativeFilter {
      readonly op = 'native:x.y' as const;
      matches() {
        return true;
      }
    }
    const explicit = new FakeRelationResolver('file', 'owner', () => true);
    const adapter = new FakeAdapter({ types: ['file'], relations: [{ type: 'file', relation: 'owner', column: 'ownerId' }, { type: 'file', relation: 'editor', column: 'editorId' }] });
    const n = new N();
    const ctx = fakeEvaluationContext({ relations: [explicit], adapters: [adapter], nativeFilters: [n] });
    ctx.trace({ step: 's', note: 'n', data: 1 });
    expect(ctx.steps).to.deep.eq([{ step: 's', note: 'n', data: 1 }]);
    expect(ctx.relation('file', 'owner')).to.eq(explicit);
    expect(ctx.relation('file', 'editor')!.relation).to.eq('editor');
    expect(ctx.nativeFilter('native:x.y')).to.eq(n);
    expect(ctx.nativeFilter('native:x.z')).to.eq(undefined);
  });

  it('uses a given check delegate and condition compiler', async () => {
    class Compiler extends ConditionCompiler {
      async compile() {
        return { filter: { op: 'true' as const }, cacheable: true, needsSubject: false };
      }
    }
    const ctx = fakeEvaluationContext({ check: async (req) => ({ allowed: true, permission: req.permission } as never), conditions: new Compiler() });
    expect((await ctx.check({ principal: undefined!, permission: 'a:b', resource: file })).allowed).to.eq(true);
    expect((await ctx.conditions.compile({ attr: 'env.x', eq: 1 }, undefined!, ctx)).filter).to.deep.eq({ op: 'true' });
  });
});

describe('fakeModelInitContext', () => {
  it('records permissions, native filters and relations, and reads config by dotted path', () => {
    class N extends NativeFilter {
      readonly op = 'native:x.y' as const;
      matches() {
        return true;
      }
    }
    const ctx = fakeModelInitContext({ domain: 'fs', model: 'rbac', config: { roles: { a: 1 } }, permissions: ['file:read'] });
    expect(ctx.domain).to.eq('fs');
    expect(ctx.config('roles.a')).to.eq(1);
    expect(ctx.config('roles.b', 7)).to.eq(7);
    expect(ctx.config('nope')).to.eq(undefined);

    ctx.registerPermissions([{ name: 'file:write', resource: 'file', action: 'write', types: ['file'] }]);
    const n = new N();
    ctx.registerNativeFilter(n);
    const rel = new FakeRelationResolver('file', 'owner', () => true);
    ctx.registerRelation(rel);

    expect(ctx.registered.permissions.map((d) => d.name)).to.deep.eq(['file:write']);
    expect(ctx.permissions.get('file:write')!.source).to.eq('model:rbac');
    expect(ctx.registered.nativeFilters).to.deep.eq([n]);
    expect(ctx.registered.relations).to.deep.eq([rel]);
  });
});
