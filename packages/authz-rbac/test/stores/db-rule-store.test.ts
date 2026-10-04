import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzAdminFailure, AuthzClock, AuthzConfigError, AuthzDomains, GLOBAL, matchGlob, matchWildcard } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef, RuleDef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { OrmDriver, QueryContext } from '@spinajs/orm';

import { AdminRuleStore, AuthzRbac_2026_10_01_00_00_00, DbRuleStore, fromSqlForm, likeToGlob, MemoryRoleStore, readVersion, RoleStore, RULE_LIST_MAX_LIMIT, RuleStore, toDate, toSqlForm } from '../../src/index.js';
import type { LadderDef } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from '../support/db.js';
import { CANVAS_LADDERS, CANVAS_RULES, F1, KIT_LADDERS, kitRuleSets, O1, P1 } from '../support/rules.js';
import type { Rule } from '../support/rules.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const AT = new Date('2026-10-01T12:00:00.000Z');
const BEFORE = new Date(AT.getTime() - 1000);
const AFTER = new Date(AT.getTime() + 1000);
const CREATED = new Date('2026-09-30T08:15:30.250Z');

const O2: ResourceRef = { type: 'org', id: 'o2' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const F2: ResourceRef = { type: 'file', id: 'f2' };
const G1: ResourceRef = { type: 'group', id: 'g1' };

const root: PrincipalRef = { type: 'user', id: 'root' };
const alice: PrincipalRef = { type: 'user', id: 'alice' };
const g1Members = { set: { role: 'group.member', scope: G1 } };

class FixedClock extends AuthzClock {
  now(): Date {
    return CREATED;
  }
}

type Row = Record<string, unknown>;

const restrict = (id: string, scope: ResourceRef, over: Partial<Rule> = {}): Rule => ({ id, kind: 'restrict', scope, allow: [alice], ...over });
const stored = (r: Rule): RuleDef => ({ ...r, expiresAt: r.expiresAt ?? null, source: 'db' });
const ids = (rules: readonly RuleDef[]) => rules.map((r) => r.id);

for (const kind of DB_KINDS) {
  describe(`DbRuleStore (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let store: DbRuleStore;

    const inTx = <R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));
    const put = (r: Rule, ladders: readonly LadderDef[] = KIT_LADDERS) => inTx((tx) => store.putWithLadders(r, ladders, root, tx));

    const ruleRows = async (): Promise<Row[]> => (await db.driver.select().from('authz_rule').orderBy('id')) as Row[];
    const subjectRows = async (ruleId?: string): Promise<Row[]> => {
      const q = db.driver.select().from('authz_rule_subject').orderBy('rule_id').orderBy('list').orderBy('subject_type').orderBy('subject_id').orderBy('subject_role');
      if (ruleId !== undefined) q.where('rule_id', ruleId);
      return (await q) as Row[];
    };
    const version = (domain = 'root') => readVersion(db.driver, domain);

    /** Counts the SELECT statements `fn` sends on the default connection. */
    const countSelects = async <R>(fn: () => Promise<R>): Promise<{ result: R; selects: number }> => {
      const target = db.driver as unknown as { executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> };
      const original = target.executeOnDb;
      let selects = 0;
      target.executeOnDb = function (stmt, params, context) {
        if (context === QueryContext.Select) selects++;
        return original.call(this, stmt, params, context);
      };
      try {
        return { result: await fn(), selects };
      } finally {
        target.executeOnDb = original;
      }
    };

    before(async function () {
      db = await bootDb(this, kind, 'rule_store', { second: true });
      await new AuthzRbac_2026_10_01_00_00_00().up(db.second!);
      db.container.register(FixedClock).as(AuthzClock);
      store = db.container.resolve(DbRuleStore);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      for (const d of [db.driver, db.second!]) {
        for (const table of ['authz_rule_subject', 'authz_rule', 'authz_version']) await rawQuery(d, `DELETE FROM ${table}`, [], QueryContext.Delete);
      }
    });

    describe('registration', () => {
      it('is an AdminRuleStore named DbRuleStore, registered by that name only', () => {
        expect(store).to.be.instanceOf(AdminRuleStore);
        expect(store).to.be.instanceOf(RuleStore);
        expect(store.name).to.eq('DbRuleStore');
        expect(db.container.resolve('DbRuleStore')).to.be.instanceOf(DbRuleStore);
        expect(DI.RootContainer.hasRegistered(RuleStore)).to.eq(false);
        expect(DI.RootContainer.hasRegistered(AdminRuleStore)).to.eq(false);
      });
    });

    describe('AdminRuleStore port', () => {
      /** A store resolved in a child container that registers `roles` as its RoleStores. */
      const withRoles = (...roles: RoleStore[]): DbRuleStore => {
        const child = db.container.child();
        for (const r of roles) child.register(testHost.instance(r)).as(RoleStore);
        return child.resolve(DbRuleStore);
      };

      it('put reads the ladders of every RoleStore of its container and writes as putWithLadders', async () => {
        const project = KIT_LADDERS.find((l) => l.name === 'project')!;
        const s = withRoles(
          new MemoryRoleStore([], [project]),
          new MemoryRoleStore(
            [],
            KIT_LADDERS.filter((l) => l !== project),
          ),
        );
        const rule: Rule = { id: 'r1', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'viewer', subjects: { refs: [root] } };

        expect(await inTx((tx) => s.put(rule, alice, tx))).to.eq(undefined);

        const form = toSqlForm(rule, KIT_LADDERS);
        const [row] = await ruleRows();
        expect(row).to.include({ id: 'r1', ladder: 'project', created_by: 'user:alice' });
        expect(Number(row.max_rank)).to.eq(form.rule.max_rank);
        expect(await s.byId('r1')).to.deep.eq(stored(rule));
        expect(await version()).to.eq('1');
      });

      it('put refuses without a RoleStore, and outside a transaction before reading one, writing nothing', async () => {
        const bare = withRoles();
        await expect(inTx((tx) => bare.put(restrict('r1', F1), root, tx))).to.be.rejectedWith(AuthzConfigError, /RoleStore/);
        await expect(withRoles(new MemoryRoleStore([], KIT_LADDERS)).put(restrict('r1', F1), root, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        await expect(inTx((tx) => withRoles(new MemoryRoleStore([], KIT_LADDERS)).put({ id: 'bad', kind: 'cap', scope: P1, ladder: 'ghost', maxRole: 'viewer' }, root, tx)))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'unknown_ladder' });
        expect(await ruleRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('put refuses a ladder that two RoleStores define, as AuthzAdmin does', async () => {
        const project = KIT_LADDERS.find((l) => l.name === 'project')!;
        const s = withRoles(new MemoryRoleStore([], [project]), new MemoryRoleStore([], [project]));
        await expect(inTx((tx) => s.put(restrict('r1', F1), root, tx))).to.be.rejectedWith(AuthzConfigError, /ladder "project" is defined twice/);
        expect(await ruleRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('assertStorable accepts a rule that put refuses with the real ladders (a role on no ladder), and put writes nothing', async () => {
        const loner: Rule = { id: 'loner', kind: 'cap', scope: P1, maxRole: 'loner' };
        expect(() => store.assertStorable(loner)).to.not.throw();

        const s = withRoles(new MemoryRoleStore([], KIT_LADDERS));
        await expect(inTx((tx) => s.put(loner, root, tx)))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'rule_not_compilable' });
        expect(await ruleRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('assertStorable accepts every kit and §8.5 rule without the ladders, and writes nothing', async () => {
        for (const rule of [...kitRuleSets().flatMap((s) => s.rules), ...CANVAS_RULES]) expect(() => store.assertStorable(rule), rule.id).to.not.throw();
        expect(await ruleRows()).to.deep.eq([]);
      });

      it('assertStorable refuses what toSqlForm refuses for the shape of the rule', () => {
        const refused = (rule: Rule, field: string) => {
          let err: unknown;
          try {
            store.assertStorable(rule);
          } catch (e) {
            err = e;
          }
          expect(err, rule.id).to.be.instanceOf(AuthzAdminFailure);
          expect(err, rule.id).to.include({ code: 'rule_not_compilable', field });
        };
        refused({ id: 'glob', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', resource: { attr: 'resource.name', glob: 'a*b*' } }, 'resource');
        refused({ id: 'perm-glob', kind: 'threshold', scope: P1, permissions: ['file:*'], minRole: 'editor' }, 'permissions');
        refused({ id: 'drops', kind: 'cap', scope: P1, maxRole: null }, 'ladder');
        refused({ id: 'actor', kind: 'cap', scope: P1, stripTags: true, subjects: { actorTypes: ['user'] } }, 'subjects.actorTypes');
      });

      it('find lists by scope and takes the page as a second argument', async () => {
        await put(restrict('r1', P1));
        await put(restrict('r2', F1));
        expect(await store.find({ scope: P1 })).to.deep.eq({ items: [stored(restrict('r1', P1))], total: 1 });
        expect(await store.find({}, { limit: 1, offset: 1 })).to.deep.eq({ items: [stored(restrict('r2', F1))], total: 2 });
      });
    });

    describe('put', () => {
      it('stores every kit and §8.5 rule as toSqlForm says, and reads it back unchanged', async () => {
        const all = [...kitRuleSets().flatMap((s) => s.rules.map((rule) => ({ rule, ladders: s.ladders }))), ...CANVAS_RULES.map((rule) => ({ rule, ladders: CANVAS_LADDERS }))];
        expect(all.length).to.be.at.least(28);

        for (const { rule, ladders } of all) {
          const returned = await put(rule, ladders);
          expect(returned, rule.id).to.deep.eq(stored(rule));

          const form = toSqlForm(rule, ladders);
          const [row] = (await db.driver.select().from('authz_rule').where('id', rule.id)) as Row[];
          const subjects = await subjectRows(rule.id);
          expect(fromSqlForm(row as never, subjects as never), rule.id).to.deep.eq(fromSqlForm(form.rule, form.subjects));
          expect(row.definition, rule.id).to.eq(form.rule.definition);
          expect(subjects, rule.id).to.deep.eq(form.subjects);
          expect(await store.byId(rule.id), rule.id).to.deep.eq(stored(rule));
        }
        expect(await version()).to.eq(String(all.length));
      });

      it('writes and reads a rule with more subject rows than one insert batch', async () => {
        const allow = Array.from({ length: 150 }, (_, i) => ({ type: 'user', id: `u${String(i).padStart(3, '0')}` }));
        await put(restrict('big', F1, { allow }));

        expect(await subjectRows('big')).to.have.length(150);
        expect((await store.byId('big'))!.allow).to.deep.eq(allow);
      });

      it('writes created_at from AuthzClock and created_by from the actor', async () => {
        await put(restrict('r1', F1));

        const [row] = await ruleRows();
        expect(row.created_by).to.eq('user:root');
        expect(toDate(row.created_at)!.getTime()).to.eq(CREATED.getTime());
      });

      it('replaces a rule with the same id: columns and subject rows, keeping created_*', async () => {
        await put(restrict('r1', F1, { allow: [alice, g1Members] }));
        await inTx((tx) => store.putWithLadders({ id: 'r1', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'viewer', subjects: { refs: [root] } }, KIT_LADDERS, alice, tx));

        const [row] = await ruleRows();
        expect(row).to.include({ kind: 'cap', scope_type: 'project', scope_id: 'p1', ladder: 'project', created_by: 'user:root' });
        expect(Number(row.max_rank)).to.eq(0);
        expect(await subjectRows()).to.deep.eq([{ rule_id: 'r1', list: 'refs', subject_type: 'user', subject_id: 'root', subject_role: '' }]);
        expect(await store.byId('r1')).to.deep.eq(stored({ id: 'r1', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'viewer', subjects: { refs: [root] } }));
        expect(await version()).to.eq('2');
      });

      it('refuses a rule outside SQL form before writing anything', async () => {
        await expect(put({ id: 'bad', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', resource: { attr: 'resource.name', glob: 'a*b*' } }))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'rule_not_compilable', field: 'resource' });
        await expect(put({ id: 'bad', kind: 'threshold', scope: P1, permissions: ['file:edit'], ladder: 'project', at: 'project', minRole: 'ghost' }))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'unknown_role' });
        await expect(put({ id: 'bad', kind: 'threshold', scope: P1, permissions: ['file:*'], minRole: 'editor' }))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'rule_not_compilable', field: 'permissions' });
        expect(await ruleRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('rolls back the rule, its subject rows and the version bump with the surrounding transaction', async () => {
        await expect(
          inTx(async (tx) => {
            await store.putWithLadders(restrict('r1', F1), KIT_LADDERS, root, tx);
            throw new Error('abort');
          }),
        ).to.be.rejectedWith('abort');

        expect(await ruleRows()).to.deep.eq([]);
        expect(await subjectRows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('reports a duplicate first insert (a concurrent put) as conflict', async () => {
        await put(restrict('r1', F1));
        class Blind extends DbRuleStore {
          protected override existingRule(): Promise<undefined> {
            return Promise.resolve(undefined);
          }
        }

        await expect(inTx((tx) => new Blind(db.container).putWithLadders(restrict('r1', F2), KIT_LADDERS, root, tx)))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'conflict', field: 'id' });
        expect((await ruleRows()).map((r) => r.scope_id)).to.deep.eq(['f1']);
        expect(await version()).to.eq('1');
      });
    });

    describe('forPath', () => {
      beforeEach(async () => {
        await put(restrict('at-global', GLOBAL));
        await put(restrict('at-o1', O1));
        await put(restrict('at-p1', P1, { allow: [alice, g1Members] }));
        await put(restrict('at-f1', F1));
        await put(restrict('at-o2', O2));
        await put(restrict('at-p2', P2));
        await put(restrict('at-f2', F2));
        await put(restrict('type-file', { type: 'file' }));
        await put(restrict('live', P1, { expiresAt: AFTER }));
        await put(restrict('expires-at-at', P1, { expiresAt: AT }));
        await put(restrict('expired', P1, { expiresAt: BEFORE }));
      });

      it('returns the live rules at the nodes of the path and at GLOBAL', async () => {
        const rules = await store.forPath([F1, P1, O1, GLOBAL], AT);
        expect(ids(rules)).to.deep.eq(['at-f1', 'at-global', 'at-o1', 'at-p1', 'live']);
        expect(rules.find((r) => r.id === 'at-p1')).to.deep.eq(stored(restrict('at-p1', P1, { allow: [alice, g1Members] })));
        expect(rules.find((r) => r.id === 'live')!.expiresAt).to.be.instanceOf(Date);
        expect(rules.find((r) => r.id === 'live')!.expiresAt!.getTime()).to.eq(AFTER.getTime());
      });

      it('adds GLOBAL when the path lacks it; an empty path gives the GLOBAL rules', async () => {
        expect(ids(await store.forPath([P2, O2], AT))).to.deep.eq(['at-global', 'at-o2', 'at-p2']);
        expect(ids(await store.forPath([], AT))).to.deep.eq(['at-global']);
      });

      it('matches a type-level ref (a list request) only to rules held at that type', async () => {
        expect(ids(await store.forPath([{ type: 'file' }, GLOBAL], AT))).to.deep.eq(['at-global', 'type-file']);
      });

      it('excludes a rule that expires exactly at `at`, includes it just before', async () => {
        expect(ids(await store.forPath([P1], BEFORE))).to.include.members(['expires-at-at', 'live']);
        expect(ids(await store.forPath([P1], BEFORE))).to.not.include('expired');
        expect(ids(await store.forPath([P1], AT))).to.not.include('expires-at-at');
      });

      it('sends one query per batch of scopes, and one for the subject rows', async () => {
        class Small extends DbRuleStore {
          protected override readonly scopeBatch = 2;
        }
        const small = new Small(db.container);
        // 10 path nodes and GLOBAL: 6 batches of at most 2
        const path = [F1, ...Array.from({ length: 7 }, (_, i) => ({ type: 'folder', id: `d${i}` })), P1, O1];

        const { result, selects } = await countSelects(() => small.forPath(path, AT));

        expect(ids(result)).to.deep.eq(['at-f1', 'at-global', 'at-o1', 'at-p1', 'live']);
        expect(selects).to.eq(7);
        expect((await countSelects(() => store.forPath(path, AT))).selects).to.eq(2);
      });

      it('answers a long path in batches', async () => {
        class Small extends DbRuleStore {
          protected override readonly scopeBatch = 2;
        }
        const small = new Small(db.container);
        const path = [F1, ...Array.from({ length: 600 }, (_, i) => ({ type: 'folder', id: `d${i}` })), P1, O1];
        expect(ids(await small.forPath(path, AT))).to.deep.eq(['at-f1', 'at-global', 'at-o1', 'at-p1', 'live']);
        expect(ids(await store.forPath(path, AT))).to.deep.eq(['at-f1', 'at-global', 'at-o1', 'at-p1', 'live']);
      });
    });

    describe('patterns on this database', () => {
      const SAMPLES = ['release', 'release/', 'release/1', 'Release/1', 'RELEASE/1', 'release/1/hotfix', 'releasex', 'a%b_c\\dz', 'aXbYc\\d', '50%_off\\', '50%_off\\/x', '50X_off\\', 'x[a]*?^]y', '[a]*?^]', 'é/ü', 'É/ü'];
      const PATTERNS: { op: 'wildcard' | 'glob'; pattern: string }[] = [
        { op: 'wildcard', pattern: 'release/*' },
        { op: 'wildcard', pattern: 'a%b_c\\d*' },
        { op: 'wildcard', pattern: '*[a]*?^]*' },
        { op: 'wildcard', pattern: 'é/*' },
        { op: 'glob', pattern: 'release/*' },
        { op: 'glob', pattern: 'release/**' },
        { op: 'glob', pattern: '50%_off\\*' },
        { op: 'glob', pattern: '[a]*' },
      ];

      /** The stored patterns of rule `id` against `text`: SQLite GLOB (its LIKE ignores case), Postgres LIKE with the backslash escape. */
      const SQL = {
        sqlite: 'SELECT (? GLOB r.resource_glob AND (r.resource_not_glob IS NULL OR NOT ? GLOB r.resource_not_glob)) AS m FROM authz_rule r WHERE r.id = ?',
        postgres: "SELECT (CAST(? AS text) LIKE r.resource_like ESCAPE '\\' AND (r.resource_not_like IS NULL OR NOT CAST(? AS text) LIKE r.resource_not_like ESCAPE '\\')) AS m FROM authz_rule r WHERE r.id = ?",
      };
      const matches = async (id: string, text: string): Promise<boolean> => {
        const [row] = (await rawQuery(db.driver, SQL[kind], [text, text, id])) as { m: unknown }[];
        return row.m === true || row.m === 1;
      };

      it('matches what the core matcher matches, case included, from the stored row', async () => {
        for (const [i, { op, pattern }] of PATTERNS.entries()) {
          const rule: Rule = { id: `p${i}`, kind: 'threshold', scope: P1, permissions: ['*'], minRole: 'editor', resource: { attr: 'resource.name', [op]: pattern } };
          await put(rule);
          const [row] = (await db.driver.select().from('authz_rule').where('id', rule.id)) as Row[];
          expect(row.resource_glob).to.eq(likeToGlob(String(row.resource_like)));

          for (const text of SAMPLES) {
            const core = op === 'glob' ? matchGlob(pattern, text) : matchWildcard(pattern, text);
            expect(await matches(rule.id, text), `${op} ${pattern} on ${JSON.stringify(text)}`).to.eq(core);
          }
        }
      });

      if (kind === 'sqlite') {
        it("SQLite's LIKE ignores case, which is why L4b needs GLOB there", async () => {
          const [row] = (await rawQuery(db.driver, "SELECT ('Release/1' LIKE 'release/%' ESCAPE '\\') AS m", [])) as { m: unknown }[];
          expect(row.m).to.eq(1);
        });
      }
    });

    describe('version', () => {
      it("reads authz_version of the store's domain, '0' when absent", async () => {
        expect(await store.version()).to.eq('0');
        await put(restrict('r1', F1));
        await put(restrict('r2', F1));
        expect(await store.version()).to.eq('2');
      });

      describe('in an authz domain', () => {
        let domain: IContainer;

        // AuthzDomains.create reads the root Configuration; the test DB's lives in a child container.
        before(async () => {
          await testHost.installHost();
          domain = DI.resolve(AuthzDomains).create(`l2_t6_${kind}`);
        });

        after(async () => {
          await domain?.dispose();
          await testHost.uninstallHost();
        });

        it("bumps and reads that domain's version, not root's", async () => {
          const driver = db.driver;
          class InDomain extends DbRuleStore {
            protected override connection(): Promise<OrmDriver> {
              return Promise.resolve(driver);
            }
          }
          const s = new InDomain(domain);
          await inTx((tx) => s.putWithLadders(restrict('r1', F1), KIT_LADDERS, root, tx));

          expect(await s.version()).to.eq('1');
          expect(await version(`l2_t6_${kind}`)).to.eq('1');
          expect(await version('root')).to.eq('0');
        });
      });
    });

    describe('delete', () => {
      it('remove deletes the rule and its subject rows, returns it and bumps once', async () => {
        await put(restrict('r1', F1, { allow: [alice, g1Members] }));
        await put(restrict('r2', F1));

        const deleted = await inTx((tx) => store.remove('r1', tx));

        expect(deleted).to.deep.eq(stored(restrict('r1', F1, { allow: [alice, g1Members] })));
        expect((await ruleRows()).map((r) => r.id)).to.deep.eq(['r2']);
        expect((await subjectRows()).map((r) => r.rule_id)).to.deep.eq(['r2']);
        expect(await version()).to.eq('3');
      });

      it('delete (the AdminRuleStore port) removes the same way and resolves to nothing', async () => {
        await put(restrict('r1', F1, { allow: [alice] }));

        expect(await inTx((tx) => store.delete('r1', tx))).to.eq(undefined);
        expect(await ruleRows()).to.deep.eq([]);
        expect(await subjectRows()).to.deep.eq([]);
        expect(await version()).to.eq('2');
      });

      it('refuses an unknown id with not_found and bumps nothing', async () => {
        await expect(inTx((tx) => store.delete('ghost', tx)))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'not_found', field: 'id' });
        expect(await version()).to.eq('0');
      });
    });

    describe('forgetScope', () => {
      it('deletes the rules at the scope (expired too) with their subject rows, and allow entries naming a set there', async () => {
        await put(restrict('at-g1', G1, { allow: [alice] }));
        await put(restrict('at-g1-expired', G1, { expiresAt: BEFORE }));
        await put(restrict('at-p1', P1, { allow: [alice, g1Members, { type: 'group', id: 'g1' }] }));
        await put({ id: 'cap-p2', kind: 'cap', scope: P2, stripTags: true, subjects: { refs: [{ type: 'group', id: 'g1' }] } });
        await put(restrict('below-g1', { type: 'group', id: 'g1x' }));

        const result = await inTx((tx) => store.forgetScopeEntries(G1, tx));

        expect(ids(result.rules)).to.deep.eq(['at-g1', 'at-g1-expired']);
        expect(result.subjects).to.deep.eq([{ ruleId: 'at-p1', list: 'allow', subject: g1Members }]);
        expect((await ruleRows()).map((r) => r.id)).to.deep.eq(['at-p1', 'below-g1', 'cap-p2']);
        expect((await subjectRows()).map((r) => [r.rule_id, r.subject_type, r.subject_id, r.subject_role])).to.deep.eq([
          ['at-p1', 'group', 'g1', ''],
          ['at-p1', 'user', 'alice', ''],
          ['below-g1', 'user', 'alice', ''],
          ['cap-p2', 'group', 'g1', ''],
        ]);
        // single checks see what SQL sees
        expect((await store.byId('at-p1'))!.allow).to.deep.eq([alice, { type: 'group', id: 'g1' }]);
        expect(await version()).to.eq('6');
      });

      it('forgetScope (the AdminRuleStore port) does the same and returns the deleted rules', async () => {
        await put(restrict('at-g1', G1, { allow: [alice] }));
        await put(restrict('at-p1', P1, { allow: [alice, g1Members] }));

        const rules = await inTx((tx) => store.forgetScope(G1, tx));

        expect(rules).to.deep.eq([stored(restrict('at-g1', G1, { allow: [alice] }))]);
        expect((await store.byId('at-p1'))!.allow).to.deep.eq([alice]);
        expect(await version()).to.eq('3');
      });

      it('refuses GLOBAL and type-level refs', async () => {
        await expect(inTx((tx) => store.forgetScope(GLOBAL, tx)))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'wrong_scope_type' });
        await expect(inTx((tx) => store.forgetScope({ type: 'project' }, tx)))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'wrong_scope_type' });
        expect(await version()).to.eq('0');
      });
    });

    describe('byId and list', () => {
      beforeEach(async () => {
        await put(restrict('r1', P1));
        await put(restrict('r2', P1, { expiresAt: BEFORE }));
        await put(restrict('r3', F1));
      });

      it('byId returns expired rules too, and null for an unknown id', async () => {
        expect((await store.byId('r2'))!.expiresAt!.getTime()).to.eq(BEFORE.getTime());
        expect(await store.byId('ghost')).to.eq(null);
      });

      it('lists by scope with expired rules, pages, and counts the unpaged result', async () => {
        expect(await store.list({ scope: P1 })).to.deep.eq({ items: [stored(restrict('r1', P1)), stored(restrict('r2', P1, { expiresAt: BEFORE }))], total: 2 });
        expect(await store.list({ page: { limit: 1, offset: 1 } })).to.deep.eq({ items: [stored(restrict('r2', P1, { expiresAt: BEFORE }))], total: 3 });
        expect(await store.list({ page: { limit: 0, offset: 0 } })).to.deep.eq({ items: [], total: 3 });
        expect(RULE_LIST_MAX_LIMIT).to.eq(1000);
      });

      it('refuses a negative or fractional page', async () => {
        await expect(store.list({ page: { limit: -1, offset: 0 } }))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'invalid_page' });
        await expect(store.list({ page: { limit: 1, offset: 0.5 } }))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'invalid_page' });
      });

      it('caps a page at maxListLimit', async () => {
        class Small extends DbRuleStore {
          protected override readonly maxListLimit = 2;
        }
        const small = new Small(db.container);
        expect((await small.list()).items).to.have.length(2);
        expect((await small.list({ page: { limit: 5, offset: 0 } })).items).to.have.length(2);
      });

      it('find without a page returns every match (one rule query); with a page it is capped', async () => {
        class Small extends DbRuleStore {
          protected override readonly maxListLimit = 2;
        }
        const small = new Small(db.container);
        const { result, selects } = await countSelects(() => small.find({}));
        expect(ids(result.items)).to.deep.eq(['r1', 'r2', 'r3']);
        expect(result.total).to.eq(3);
        expect(selects, 'one rule query and one subject query').to.eq(2);
        const paged = await small.find({}, { limit: 5, offset: 0 });
        expect(ids(paged.items)).to.deep.eq(['r1', 'r2']);
        expect(paged.total).to.eq(3);
      });
    });

    describe('writes outside an AuthzAdmin transaction', () => {
      it('are refused without a transaction in scope, or with something that is not a driver', async () => {
        await put(restrict('w1', P1));
        await expect(store.putWithLadders(restrict('r1', F1), KIT_LADDERS, root, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        await expect(store.putWithLadders(restrict('r1', F1), KIT_LADDERS, root, { driver: {} })).to.be.rejectedWith(AuthzConfigError, /OrmDriver/);
        await expect(store.delete('w1', { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        await expect(store.forgetScope(P1, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        expect((await ruleRows()).map((r) => r.id)).to.deep.eq(['w1']);
        expect(await version()).to.eq('1');
      });

      it('are refused on a transaction of another connection (D-L2-2)', async () => {
        await put(restrict('w1', P1));
        const other = (fn: (tx: AuthzTx) => Promise<unknown>) => db.second!.transaction((driver: OrmDriver) => fn({ driver }));

        await expect(other((tx) => store.putWithLadders(restrict('r1', F1), KIT_LADDERS, root, tx))).to.be.rejectedWith(AuthzConfigError, /l2-rule_store-second/);
        await expect(other((tx) => store.delete('w1', tx))).to.be.rejectedWith(AuthzConfigError, /connection/);
        await expect(other((tx) => store.forgetScope(P1, tx))).to.be.rejectedWith(AuthzConfigError, /connection/);

        expect(await rawQuery(db.second!, 'SELECT id FROM authz_rule')).to.deep.eq([]);
        expect(await rawQuery(db.second!, 'SELECT domain FROM authz_version')).to.deep.eq([]);
        expect((await ruleRows()).map((r) => r.id)).to.deep.eq(['w1']);
        expect(await version()).to.eq('1');
      });
    });
  });
}
