import { AuthzClock, AuthzConfigError } from '@spinajs/authz';
import { OrmNativeCompiler } from '@spinajs/authz-orm';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { expect } from 'chai';
import 'mocha';

import { RBAC_ASSIGNMENT_OP, compileRoles } from '../../src/index.js';
import type { RbacModel, RoleDef, RoleGraph } from '../../src/index.js';
import { RbacModelRoleGraphSource, RbacOrmCompiler, RbacRoleGraphSource, RbacScopePathSource, rbacRoleScopes } from '../../src/orm/index.js';
import { args, bootSqlite, compilerContainer, DocModel, FixedClock, FixturePathSource, GRAPH, NOW, principal, STAFF, T1_MEMBERS, U1, U1_ARGS, UnscopedModel } from './fixture.js';
import type { BootedDb } from './fixture.js';

const ARG_VALUES = ['u1', 't1', 'team.member', 'viewer', 'editor', '$global'];

function compiled(driver: OrmDriver, compiler: RbacOrmCompiler, termArgs: unknown, build?: (q: SelectQueryBuilder) => void) {
  const query = driver.select().from('doc', 't');
  build?.(query);
  compiler.compile(termArgs, query, DocModel, principal('u1'));
  const out = query.toDB() as unknown as { expression: string; bindings: unknown[] };
  return { sql: out.expression, bindings: out.bindings };
}

function compilerWith(graph: (() => RoleGraph | undefined) | null): RbacOrmCompiler {
  const container = DI.child();
  container.register(FixturePathSource).as(RbacScopePathSource);
  container.register(FixedClock).as(AuthzClock);
  if (graph) {
    container
      .register(
        class extends RbacRoleGraphSource {
          graph() {
            return graph!();
          }
        },
      )
      .as(RbacRoleGraphSource);
  }
  return new RbacOrmCompiler(container);
}

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: [{ permission: 'doc:read' }], ...extra });

describe('authz-rbac orm: RbacOrmCompiler SQL', function () {
  this.timeout(30000);

  let db: BootedDb;
  const { compiler } = compilerContainer();

  before(async () => {
    db = await bootSqlite();
  });

  after(async () => {
    await db?.close();
  });

  it('compiles native:rbac.assignment', () => {
    expect(compiler.op).to.equal(RBAC_ASSIGNMENT_OP);
  });

  it('builds one correlated EXISTS over authz_assignment (sqlite)', () => {
    const { sql, bindings } = compiled(db.driver, compiler, U1_ARGS);

    expect(sql).to.match(/WHERE EXISTS \( SELECT .* FROM `authz_assignment` as `authz_a` WHERE /);
    expect(sql).to.contain('`authz_a`.`subject_type` = ? AND `authz_a`.`subject_id` = ? AND `authz_a`.`subject_role` = ?');
    expect(sql).to.contain('`authz_a`.`role` IN (?,?)');
    expect(sql).to.contain('`authz_a`.`expires_at` IS NULL OR `authz_a`.`expires_at` > ?');
    expect(sql).to.contain('`authz_a`.`scope_type` = ? AND `authz_a`.`scope_id` = ?');
    expect(sql).to.contain('`authz_a`.`scope_type` = ? AND `authz_a`.`scope_id` <> ? AND `authz_a`.`scope_id` = CAST(`t`.`id` AS CHAR)');
    expect(sql).to.contain('`authz_a`.`scope_id` = CAST(`t`.`project_id` AS CHAR)');
    expect(sql).to.contain('`authz_a`.`scope_id` = CAST(`t`.`org_id` AS CHAR)');

    expect(bindings).to.include.members(['user', 'u1', '', 'team', 't1', 'team.member', 'viewer', 'editor', '$global', 'doc', 'project', 'org']);
  });

  it('binds every args value and never writes one into the SQL text', () => {
    const evil = "x' OR '1'='1";
    const evilCompiler = compilerWith(() => compileRoles([role(evil, { scopeTypes: ["doc'; --"] })]));
    const { sql, bindings } = compiled(db.driver, evilCompiler, args([{ type: 'user', id: "'; DROP TABLE doc; --" }], [evil]));

    expect(bindings).to.include.members([evil, "doc'; --", "'; DROP TABLE doc; --"]);
    expect(sql).to.not.contain('DROP TABLE');
    expect(sql).to.not.contain("'1'='1");
    expect(sql).to.not.contain("doc'");
    for (const value of ARG_VALUES) {
      expect(compiled(db.driver, compiler, U1_ARGS).sql).to.not.contain(value);
    }
  });

  it('binds now from the authz clock, through the driver datetime converter', () => {
    const { bindings } = compiled(db.driver, compiler, U1_ARGS);
    const nowBinding = bindings.find((b) => typeof b === 'string' && /^\d{4}-\d{2}-\d{2} /.test(b));

    expect(nowBinding, 'a converted datetime binding').to.be.a('string');
    expect(new Date((nowBinding as string).replace(' ', 'T')).getTime()).to.equal(NOW.getTime());
  });

  it('ORs one equality triple per subject, no row-value IN', () => {
    const { sql } = compiled(db.driver, compiler, args([U1, { type: 'user', id: 'u9' }, T1_MEMBERS], ['viewer']));

    expect(sql.match(/`authz_a`\.`subject_type` = \?/g)).to.have.length(3);
    expect(sql).to.not.match(/\(\s*`authz_a`\.`subject_type`\s*,/);
  });

  it('writes subjects as the store does: a principal with role "", a set at GLOBAL as ($global, "")', () => {
    const { bindings } = compiled(db.driver, compiler, args([STAFF, U1], ['viewer']));
    expect(bindings.slice(0, 6)).to.deep.equal(['$global', '', 'staff', 'user', 'u1', '']);
  });

  it('refuses a subject set with an empty role in compile(), before any SQL is built: it would read as the principal', () => {
    const query = db.driver.select().from('doc', 't');
    expect(() => compiler.compile(args([{ set: { role: '', scope: { type: 'team', id: 't1' } } }], ['viewer']), query, DocModel, principal('u1'))).to.throw(AuthzConfigError, /empty role/);
  });

  it('lists $global, the type-only scope of the row type, the row and every scope column on the path', () => {
    const { bindings } = compiled(db.driver, compiler, U1_ARGS);
    const at = bindings.indexOf('$global');

    expect(bindings.slice(at)).to.deep.equal(['$global', 'doc', '', 'doc', '', 'project', '', 'org', '']);
  });

  it('checks each role against its definition: scopeTypes as constants, unassignable and undefined roles left out', () => {
    const { sql, bindings } = compiled(db.driver, compiler, args([U1], ['fixed', 'ghost', 'orgOnly', 'projectLead', 'viewer']));

    expect(sql).to.contain('( `authz_a`.`role` IN (?) ) OR ( `authz_a`.`role` = ? AND `authz_a`.`scope_type` IN (?) ) OR ( `authz_a`.`role` = ? AND `authz_a`.`scope_type` IN (?,?) )');
    expect(bindings).to.include.ordered.members(['user', 'u1', '', 'viewer', 'orgOnly', 'org', 'projectLead', 'project', '$global']);
    expect(bindings).to.not.include.members(['fixed', 'ghost']);
  });

  it('roles with no usable definition compile to a constant false', () => {
    const { sql, bindings } = compiled(db.driver, compiler, args([U1], ['fixed', 'ghost']));
    expect(sql).to.contain('1 = 0');
    expect(sql).to.not.contain('EXISTS');
    expect(bindings).to.deep.equal([]);
  });

  it('empty roles or subjects compile to a constant false, never IN ()', () => {
    for (const termArgs of [args([U1, T1_MEMBERS], []), args([], ['viewer'])]) {
      const { sql, bindings } = compiled(db.driver, compiler, termArgs);
      expect(sql).to.contain('1 = 0');
      expect(sql).to.not.contain('EXISTS');
      expect(sql).to.not.contain('IN ()');
      expect(bindings).to.deep.equal([]);
    }
  });

  it('refuses args that are not exactly L1 v1 with an AuthzConfigError', () => {
    const malformed: unknown[] = [undefined, { roles: 'viewer', subjects: [] }, { roles: ['viewer'], subjects: [{ type: 'user', id: 'u1', role: '' }] }, { ...U1_ARGS, v: 2 }, { ...U1_ARGS, restrict: [] }, { ...U1_ARGS, roles: ['viewer', 'editor'] }, { ...U1_ARGS, subjects: [...U1_ARGS.subjects].reverse() }];
    for (const bad of malformed) {
      expect(() => compiled(db.driver, compiler, bad), JSON.stringify(bad)).to.throw(AuthzConfigError, /native:rbac\.assignment/);
    }
  });

  it('refuses a model with no scope path', () => {
    const query = db.driver.select().from('doc');
    expect(() => compiler.compile(U1_ARGS, query, UnscopedModel, principal('u1'))).to.throw(AuthzConfigError, /UnscopedModel/);
  });

  it('refuses when no RbacScopePathSource is registered', () => {
    const query = db.driver.select().from('doc');
    expect(() => new RbacOrmCompiler(DI.child()).compile(U1_ARGS, query, DocModel, principal('u1'))).to.throw(AuthzConfigError, /RbacScopePathSource/);
  });

  it('refuses when no RbacRoleGraphSource is registered', () => {
    expect(() => compiled(db.driver, compilerWith(null), U1_ARGS)).to.throw(AuthzConfigError, /RbacRoleGraphSource/);
  });

  it('refuses before the role definitions are compiled (fail closed)', () => {
    expect(() =>
      compiled(
        db.driver,
        compilerWith(() => undefined),
        U1_ARGS,
      ),
    ).to.throw(AuthzConfigError, /not compiled/);
  });

  it('RbacModelRoleGraphSource reads the current graph of its model, registered with a factory', () => {
    let current = compileRoles([role('viewer')]);
    const model = { roleGraph: () => current } as unknown as RbacModel;
    const container = DI.child();
    container.register(FixturePathSource).as(RbacScopePathSource);
    container.register(FixedClock).as(AuthzClock);
    container.register(() => new RbacModelRoleGraphSource(model, [DocModel])).as(RbacRoleGraphSource);
    const fromModel = new RbacOrmCompiler(container);

    expect(compiled(db.driver, fromModel, args([U1], ['viewer'])).sql).to.contain('EXISTS');
    current = compileRoles([role('viewer', { assignable: false })]);
    expect(compiled(db.driver, fromModel, args([U1], ['viewer'])).sql).to.not.contain('EXISTS');
  });

  it('RbacModelRoleGraphSource serves only the ORM models it is given; any other fails closed', () => {
    const model = { roleGraph: () => GRAPH } as unknown as RbacModel;
    expect(new RbacModelRoleGraphSource(model, [DocModel]).graph(DocModel)).to.equal(GRAPH);
    expect(new RbacModelRoleGraphSource(model, [DocModel]).graph(UnscopedModel)).to.equal(undefined);
    expect(new RbacModelRoleGraphSource(model, (m) => m === DocModel).graph(UnscopedModel)).to.equal(undefined);
    expect(new RbacModelRoleGraphSource(model, (m) => m === DocModel).graph(DocModel)).to.equal(GRAPH);

    const container = DI.child();
    container.register(FixturePathSource).as(RbacScopePathSource);
    container.register(FixedClock).as(AuthzClock);
    container.register(() => new RbacModelRoleGraphSource(model, [UnscopedModel])).as(RbacRoleGraphSource);
    const query = db.driver.select().from('doc', 't');
    expect(() => new RbacOrmCompiler(container).compile(U1_ARGS, query, DocModel, principal('u1'))).to.throw(AuthzConfigError, /DocModel/);
  });

  it('takes the outer table name when the query has no alias', () => {
    const query = db.driver.select().from('doc');
    compiler.compile(U1_ARGS, query, DocModel, principal('u1'));
    expect(query.toDB().expression).to.contain('CAST(`doc`.`project_id` AS CHAR)');
  });

  it('reads the outer alias when the SQL is built, not when compile runs', () => {
    const query = db.driver.select().from('doc');
    compiler.compile(U1_ARGS, query, DocModel, principal('u1'));
    query.setAlias('late');
    expect(query.toDB().expression).to.contain('CAST(`late`.`project_id` AS CHAR)');
  });

  it('a clone correlates with the clone', () => {
    const query = db.driver.select().from('doc', 't');
    compiler.compile(U1_ARGS, query, DocModel, principal('u1'));
    const clone = query.clone().setAlias('c');
    expect(clone.toDB().expression).to.contain('CAST(`c`.`id` AS CHAR)');
    expect(query.toDB().expression).to.contain('CAST(`t`.`id` AS CHAR)');
  });

  it('compiles inside a nested where group (and/or residuals)', () => {
    const { sql } = compiled(db.driver, compiler, args([], []), (q) => q.where('id', '>', 0));
    expect(sql).to.contain('1 = 0');

    const query = db.driver.select().from('doc', 't');
    query.where('id', 0).orWhere(function () {
      compiler.compile(U1_ARGS, this, DocModel, principal('u1'));
    });
    const nested = query.toDB().expression;
    expect(nested).to.match(/OR \( EXISTS \( SELECT .* FROM `authz_assignment` as `authz_a`/);
    expect(nested).to.contain('CAST(`t`.`id` AS CHAR)');
  });

  it('refuses an outer alias equal to the assignment alias', () => {
    const query = db.driver.select().from('doc', 'authz_a');
    compiler.compile(U1_ARGS, query, DocModel, principal('u1'));
    expect(() => query.toDB()).to.throw(AuthzConfigError, /authz_a/);
  });

  describe('rbacRoleScopes', () => {
    it('splits roles by scopeTypes and drops undefined and unassignable ones, each once', () => {
      expect(rbacRoleScopes(GRAPH, ['viewer', 'orgOnly', 'fixed', 'ghost', 'viewer', 'projectLead'])).to.deep.equal({
        anyScope: ['viewer'],
        scoped: [
          { role: 'orgOnly', scopeTypes: ['org'] },
          { role: 'projectLead', scopeTypes: ['project', '$global'] },
        ],
      });
    });
  });

  describe('postgres dialect (no server)', () => {
    let pg: PostgresOrmDriver;
    let container: IContainer;

    before(async () => {
      container = DI.child();
      pg = await container.resolve(PostgresOrmDriver, [{ Name: 'l2-orm-pg-dialect', Driver: 'orm-driver-postgres' }]);
    });

    after(async () => {
      await container.dispose();
    });

    it('quotes with double quotes and casts to TEXT, so no id is cut', () => {
      const { sql } = compiled(pg, compiler, U1_ARGS);

      expect(sql).to.match(/EXISTS \( SELECT .* FROM "authz_assignment" as "authz_a" WHERE /);
      expect(sql).to.contain('"authz_a"."subject_type" = ?');
      expect(sql).to.contain('"authz_a"."scope_id" = CAST("t"."id" AS TEXT)');
      expect(sql).to.contain('"authz_a"."scope_id" = CAST("t"."org_id" AS TEXT)');
      expect(sql).to.not.contain('`');
      expect(sql).to.not.match(/CAST\([^)]*\(\d+\)\)/);
    });
  });

  describe('DI', () => {
    it('is registered as an OrmNativeCompiler for authz-orm to collect', () => {
      expect(DI.RootContainer.hasRegisteredType(OrmNativeCompiler, RbacOrmCompiler)).to.equal(true);
    });

    it('RbacScopePathSource and RbacRoleGraphSource have no default implementation', () => {
      expect(DI.RootContainer.hasRegistered(RbacScopePathSource)).to.equal(false);
      expect(DI.RootContainer.hasRegistered(RbacRoleGraphSource)).to.equal(false);
    });
  });
});
