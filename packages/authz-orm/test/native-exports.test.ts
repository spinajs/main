import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AccessResource, OrmNativeCompiler, ScopeColumn } from '../src/index.js';
import { compileResidual } from '../src/compile/compiler.js';
import '../src/middleware.js';
import { accessResourceModels, accessResourceTypeOf, correlatedQuery, isNativeBuilder, scopePathOf, sql, whereSqlWithAliases } from '../src/native.js';
import { unregisterResource } from '../src/registry.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { systemIt } from './support/system.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const OP = 'native:test.exports' as const;

/** What the compiler of OP does with the builder it is handed; set per test. */
let shape: (builder: IWhereBuilder<unknown>) => void = () => undefined;

class ExportsCompiler extends OrmNativeCompiler {
  readonly op = OP;
  compile(_args: unknown, builder: IWhereBuilder<unknown>): void {
    shape(builder);
  }
}

describe('authz-orm/native: the exports L4b reads', function () {
  this.timeout(120000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    await (await testHost.domains()).service('root');
    DI.register(ExportsCompiler).as(OrmNativeCompiler);
  });

  after(async () => {
    DI.unregister(ExportsCompiler);
    DI.uncache(ExportsCompiler);
    DI.uncache(OrmNativeCompiler);
    await db?.close();
  });

  afterEach(async () => {
    shape = () => undefined;
    await db.clear();
  });

  const doc = (dialect: Dialect, name = 'XDoc', columns: Record<string, string> = { org_id: 'TEXT' }) =>
    db.define(
      {
        name,
        columns,
        rows: [{ id: 'd1', org_id: 'o1' }],
        decorate: (cls, proto) => {
          AccessResource('xdoc', { attributes: ['org_id'] })(cls);
          ScopeColumn('org_id', 'org')(proto, 'org_id');
          ScopeColumn('ghost_id', 'org')(proto, 'ghost');
        },
      },
      dialect,
    );

  describe('scopePathOf, accessResourceModels, accessResourceTypeOf', () => {
    it('reads the type, table, key and scope columns with their id modes, and the models registered before', async () => {
      const First = await doc('sqlite');
      const Second = await doc('sqlite', 'XDoc2');
      expect(scopePathOf(First as never)).to.deep.equal({
        type: 'xdoc',
        table: db.table(First),
        id: { column: 'id', idMode: 'string' },
        scopes: [
          { column: 'org_id', scopeType: 'org', idMode: 'string' },
          { column: 'ghost_id', scopeType: 'org', idMode: 'none' },
        ],
        attributes: ['org_id'],
        before: [],
      });
      expect(scopePathOf(Second as never)!.before).to.deep.equal([{ table: db.table(First), id: { column: 'id', idMode: 'string' } }]);
      expect(scopePathOf(class NotAResource extends ModelBase {} as never)).to.equal(null);
      expect(accessResourceModels('xdoc')).to.deep.equal([First, Second]);
      expect(accessResourceModels()).to.include.members([First, Second]);
      expect(accessResourceTypeOf(Second as never)).to.equal('xdoc');
      expect(accessResourceTypeOf(class Plain extends ModelBase {} as never)).to.equal(undefined);
    });

    it('reads integer keys as number ids and a BLOB column as none (SQLite)', async () => {
      const Typed = await db.define({ name: 'XTyped', columns: { id: 'INT', b_id: 'BLOB' }, decorate: (cls, proto) => (AccessResource('xtyped')(cls), ScopeColumn('b_id', 'org')(proto, 'b_id')) }, 'sqlite');
      expect(scopePathOf(Typed as never)).to.deep.include({ id: { column: 'id', idMode: 'number' }, scopes: [{ column: 'b_id', scopeType: 'org', idMode: 'none' }] });
    });

    it('reads bigint and uuid keys as text ids; a model on another connection is null in before (Postgres)', async function () {
      if (!pg) return this.skip();
      const First = await doc('sqlite');
      const Pg = await db.define({ name: 'XPg', columns: { id: 'BIGINT', org_id: 'UUID' }, decorate: (cls, proto) => (AccessResource('xdoc')(cls), ScopeColumn('org_id', 'org')(proto, 'org_id')) }, 'postgres');
      const p = scopePathOf(Pg as never)!;
      expect(p.id).to.deep.equal({ column: 'id', idMode: 'text' });
      expect(p.scopes).to.deep.equal([{ column: 'org_id', scopeType: 'org', idMode: 'text' }]);
      expect(p.before).to.deep.equal([null]);
      expect(accessResourceModels('xdoc')).to.deep.equal([First, Pg]);
    });

    it('an unregistered subclass reads as the registered class findRow loads; with a table of its own its key is none', async () => {
      const Base = await doc('sqlite');
      const Sub = await db.define({ name: 'XSub', columns: { org_id: 'TEXT', team_id: 'TEXT' }, base: Base, decorate: (_cls, proto) => ScopeColumn('team_id', 'team')(proto, 'team_id') }, 'sqlite');
      const p = scopePathOf(Sub as never)!;
      expect(p.type).to.equal('xdoc');
      expect(p.table).to.equal(db.table(Sub));
      expect(p.id).to.deep.equal({ column: 'id', idMode: 'none' });
      expect(p.scopes).to.deep.equal(scopePathOf(Base as never)!.scopes);
    });

    it('a registered class without a table gives an AuthzConfigError, and only for itself', () => {
      class NoTable extends ModelBase {}
      AccessResource('xnotable')(NoTable);
      try {
        expect(() => scopePathOf(NoTable as never)).to.throw(AuthzConfigError, /has no table/);
        expect(accessResourceTypeOf(NoTable as never)).to.equal('xnotable');
      } finally {
        unregisterResource(NoTable);
      }
    });
  });

  describe('isNativeBuilder and whereSqlWithAliases', () => {
    /** A query of `Doc` with OP compiled into it (boxed: a query is thenable and would run when returned). */
    const compiled = (Doc: unknown, alias?: string): { q: any } => {
      const q = (Doc as { query(): any }).query();
      if (alias) q.setAlias(alias);
      compileResidual({ op: OP, args: {} } as unknown as ResourceFilter, q, { model: Doc as never, principal: alice, op: 'read' });
      return { q };
    };

    systemIt('isNativeBuilder: the native builder, a where group in it and a correlatedQuery sub-query; not a plain query', async () => {
      const Doc = await doc('sqlite');
      const seen: boolean[] = [];
      shape = (builder) => {
        seen.push(isNativeBuilder(builder));
        builder.where(function (this: IWhereBuilder<unknown>) {
          seen.push(isNativeBuilder(this));
          whereSqlWithAliases(this, sql`1 = 1`, []);
        });
        const sub = correlatedQuery(builder, db.table(Doc));
        seen.push(isNativeBuilder(sub));
        builder.whereExist(sub);
      };
      compiled(Doc);
      expect(seen).to.deep.equal([true, true, true]);
      expect(isNativeBuilder((Doc as unknown as { query(): unknown }).query())).to.equal(false);
      expect(isNativeBuilder(undefined)).to.equal(false);
    });

    systemIt('refuses, when the query compiles, a filtered row that goes by one of the aliases in any letter case; clones keep it', async () => {
      const Doc = await doc('sqlite');
      shape = (builder) => void whereSqlWithAliases(builder, sql`1 = 1`, ['Mine']);
      const plain = compiled(Doc).q;
      expect(((await plain.clone()) as unknown[]).length).to.equal(1);
      expect(() => plain.clone().setAlias('mine').toDB()).to.throw(AuthzConfigError, /goes by "mine"/);
      const aliased = compiled(Doc, 'MINE').q;
      expect(() => aliased.toDB()).to.throw(AuthzConfigError, /goes by "MINE"/);
      expect(() => aliased.clone().toDB()).to.throw(AuthzConfigError);
      expect(((await aliased.clone().setAlias('other')) as unknown[]).length).to.equal(1);
    });

    systemIt('refuses a builder outside a native compilation, a fragment not made by sql and an empty alias', async () => {
      const Doc = await doc('sqlite');
      expect(() => whereSqlWithAliases((Doc as unknown as { query(): IWhereBuilder<unknown> }).query(), sql`1 = 1`, [])).to.throw(AuthzConfigError, /whereSqlWithAliases/);
      for (const bad of [() => whereSqlWithAliases(builderOf, '1 = 1' as never, []), () => whereSqlWithAliases(builderOf, sql`1 = 1`, [''])]) {
        shape = (builder) => {
          builderOf = builder;
          bad();
        };
        expect(() => compiled(Doc)).to.throw(AuthzConfigError);
      }
    });
  });
});

let builderOf: IWhereBuilder<unknown>;
