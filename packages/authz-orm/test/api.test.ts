import * as chai from 'chai';
import 'mocha';

import { AccessResource, OrmNativeCompiler, OrmScope, OrmScopePolicy, Owner, ScopeColumn, filterFields, ownsBy, registerAccessResource } from '../src/index.js';
import * as root from '../src/index.js';
import * as stubs from '../src/api.js';
import type { Decision, Permission, Principal, RelationResolver, ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { IWhereBuilder, InsertQueryBuilder, ModelBase, UpdateQueryBuilder } from '@spinajs/orm';

const expect = chai.expect;

const principal = { type: 'user', id: 'u1' } as Principal;
const model = class Fake {} as unknown as Class<ModelBase>;
const notImplemented = (name: string) => new RegExp(`^@spinajs/authz-orm: ${name} is not implemented yet$`);

class MinimalPolicy extends OrmScopePolicy {
  scope(_query: IWhereBuilder<ModelBase>, _principal: Principal, _op: 'read' | 'update' | 'delete'): void {}
}

class FullPolicy extends OrmScopePolicy<ModelBase> {
  scope(_query: IWhereBuilder<ModelBase>, _principal: Principal, _op: 'read' | 'update' | 'delete'): void {}
  async authorizeCreate(_query: InsertQueryBuilder, _principal: Principal): Promise<void> {}
  authorizeUpdate(_query: UpdateQueryBuilder<ModelBase>, _values: Record<string, unknown>, _principal: Principal): void {}
  holds(_principal: Principal, _row: ModelBase): boolean {
    return true;
  }
}

class FakeCompiler extends OrmNativeCompiler {
  readonly op = 'native:rbac.assignment' as const;
  compile(_args: unknown, _builder: IWhereBuilder<unknown>, _model: Class<ModelBase>, _principal: Principal): void {}
}

describe('authz-orm api', () => {
  // api.ts is frozen and keeps its stubs; src/index.ts exports the implementations in their place.
  it('every stub of api.ts throws not implemented', () => {
    const { AccessResource, Owner, ScopeColumn, OrmScope, filterFields, registerAccessResource, ownsBy } = stubs;
    expect(() => AccessResource('file')).to.throw(Error, notImplemented('AccessResource'));
    expect(() => AccessResource('file', { relationScope: 'join', permissions: { read: 'file:read' }, attributes: ['policies'] })).to.throw(Error, notImplemented('AccessResource'));
    expect(() => Owner()).to.throw(Error, notImplemented('Owner'));
    expect(() => ScopeColumn('project_id', 'project')).to.throw(Error, notImplemented('ScopeColumn'));
    expect(() => OrmScope(model, 'pool')).to.throw(Error, notImplemented('OrmScope'));
    expect(() => filterFields({} as Decision, { a: 1 }, 'read')).to.throw(Error, notImplemented('filterFields'));
    expect(() => registerAccessResource(model, 'job', { attributes: [] })).to.throw(Error, notImplemented('registerAccessResource'));
    expect(() => ownsBy<{ OwnerId: string }>('file', 'owner', (p, row) => row.OwnerId === p.id)).to.throw(Error, notImplemented('ownsBy'));
  });

  it('abstract classes are runtime exports and take minimal fakes', () => {
    for (const k of ['OrmScopePolicy', 'OrmNativeCompiler']) {
      expect((root as any)[k], k).to.be.a('function');
    }
    const minimal = new MinimalPolicy();
    const full = new FullPolicy();
    expect(minimal.authorizeCreate).to.equal(undefined);
    expect(minimal.authorizeUpdate).to.equal(undefined);
    expect(minimal.holds).to.equal(undefined);
    expect(full.holds!(principal, {} as ModelBase)).to.equal(true);
    expect(new FakeCompiler().op).to.equal('native:rbac.assignment');
  });

  it('OrmNativeCompiler.op must be a native op', () => {
    class Bad extends OrmNativeCompiler {
      // @ts-expect-error op must match `native:${string}`
      readonly op = 'cmp' as const;
      compile(): void {}
    }
    expect(new Bad().op).to.equal('cmp');
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

describe('authz-orm pinned shapes', () => {
  it('match the design exactly', () => {
    type AccessResourceOptions = { relationScope?: 'where' | 'join'; permissions?: { read?: Permission; create?: Permission; update?: Permission; delete?: Permission }; attributes?: readonly string[] };
    yes<Equal<typeof AccessResource, (type: ResourceType, opts?: AccessResourceOptions) => ClassDecorator>>();
    yes<Equal<typeof Owner, () => PropertyDecorator>>();
    yes<Equal<typeof ScopeColumn, (column: string, scopeType: ResourceType) => PropertyDecorator>>();
    yes<Equal<typeof OrmScope, (model: Class<ModelBase>, relation: string) => ClassDecorator>>();
    yes<Equal<typeof filterFields, <T>(decision: Decision, data: T, mode: 'read' | 'write') => { data: Partial<T>; removed: string[] }>>();
    yes<Equal<typeof registerAccessResource, (model: Class<ModelBase>, type: ResourceType, opts?: Parameters<typeof AccessResource>[1]) => void>>();
    yes<Equal<Parameters<typeof registerAccessResource>[2], AccessResourceOptions | undefined>>();
    yes<Equal<typeof ownsBy, <T>(type: ResourceType, relation: string, fn: (p: Principal, row: T) => boolean) => RelationResolver>>();
    yes<
      Equal<
        Shape<OrmScopePolicy>,
        {
          scope(query: IWhereBuilder<ModelBase>, principal: Principal, op: 'read' | 'update' | 'delete'): void;
          authorizeCreate?(query: InsertQueryBuilder, principal: Principal): void | Promise<void>;
          authorizeUpdate?(query: UpdateQueryBuilder<ModelBase>, values: Record<string, unknown>, principal: Principal): void | Promise<void>;
          holds?(principal: Principal, row: ModelBase): boolean | Promise<boolean>;
        }
      >
    >();
    yes<Equal<Shape<OrmNativeCompiler>, { readonly op: `native:${string}`; compile(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>, principal: Principal): void }>>();
    expect(true).to.equal(true);
  });
});
