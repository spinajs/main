import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthorizationModel, ChangeBus, SYSTEM } from '@spinajs/authz';
import type { AuthzChange, AuthzService, DecisionRequest, EvaluationContext, Principal, Vote } from '@spinajs/authz';
import { FakeRbacModel, RecordingChangeBus, testHost, userPrincipal } from '@spinajs/authz-testing';
import { InsertBehaviour } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { publishMoved } from '../../src/ancestors/moved.js';
import { ormLog } from '../../src/host.js';
import { AccessResource, Parent, reparent } from '../../src/index.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

type Where = { where(...a: unknown[]): Promise<unknown>; whereIn(...a: unknown[]): Promise<unknown> };
type M = typeof ModelBase & { insert(v: object | object[], b?: InsertBehaviour): Promise<unknown>; update(v: object): Where };

const ticks = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Counts the votes it was asked for, so a test can tell a cached decision from a new one. */
class CountingRbac extends FakeRbacModel {
  evaluations = 0;

  evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    this.evaluations++;
    return super.evaluate(req, ctx);
  }
}

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

describe('a move under another parent', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const published: { change: AuthzChange; inTx: boolean }[] = [];
  const undo: (() => void)[] = [];

  const setConfig = (path: string[], value: unknown) => {
    const config = testHost.config();
    const prev = config.get<unknown>(path);
    config.set(path, value);
    undo.push(() => (prev === undefined ? config.unset(path) : config.set(path, prev)));
  };

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let driver: OrmDriver;
      let model: CountingRbac;
      let service: AuthzService;
      let Org: M;
      let Project: M;
      let Task: M;

      const canRead = async (id: number, principal: Principal = alice) => (await service.check({ principal, permission: 'task:read', resource: { type: 'task', id: String(id) } })).allowed;
      const tagsPublished = () => published.map((p) => p.change.tags);

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        // A fresh instance per run: DI caches a singleton by class name, so a class declared here would leak into the next dialect.
        const bus = new RecordingChangeBus();
        model = new CountingRbac({
          roles: { viewer: ['task:read'] },
          assignments: [
            { subject: { type: alice.type, id: alice.id }, role: 'viewer', scope: { type: 'org', id: 'o1' } },
            { subject: { type: bob.type, id: bob.id }, role: 'viewer', scope: { type: 'region', id: 'r1' } },
          ],
        });
        published.length = 0;
        undo.push(testHost.registerInRoot(ChangeBus, testHost.instance(bus)));
        undo.push(testHost.registerInRoot(AuthorizationModel, testHost.named('rbac', testHost.instance(model))));
        setConfig(['authz', 'permissions'], { 'task:read': { types: ['task'] } });
        setConfig(['authz', 'models'], ['rbac']);
        setConfig(['authz', 'combine'], { default: { algorithm: 'deny-overrides', models: ['rbac'] } });
        await createAncestorTable(db, dialect);
        // Before the boot: the domain indexes its adapters' types once and refuses a type registered after it.
        Org = (await db.define({ name: 'Org', columns: { region_id: 'TEXT' }, decorate: (c, p) => { AccessResource('org')(c); Parent('region')(p, 'region_id'); } }, dialect)) as M;
        Project = (await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect)) as M;
        Task = (await db.define({ name: 'Task', columns: { id: 'INTEGER', project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        service = await (await testHost.domains()).service('root');
        bus.subscribe((change) => published.push({ change, inTx: driver.CurrentTransaction !== undefined }));
        await Org.insert([{ id: 'o1', region_id: 'r1' }, { id: 'o2', region_id: 'r2' }]);
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o1' }, { id: 'p3', org_id: 'o2' }]);
        await Task.insert([{ id: 1, project_id: 'p1' }, { id: 2, project_id: 'p2' }]);
      });

      // Not resetHost: it would also empty the config TestDb put its connections in.
      afterEach(async () => {
        for (const fn of undo.splice(0).reverse()) fn();
        await testHost.resetRoot();
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('drops a decision cached through the old parent in the writing process', async () => {
        expect(await canRead(1)).to.equal(true);
        expect(await canRead(1)).to.equal(true);
        expect(model.evaluations, 'the second check is answered from the decision cache').to.equal(1);

        expect(await reparent(Project, ['p1'], 'o2')).to.equal(1);
        await ticks();

        expect(await canRead(1)).to.equal(false);
        expect(model.evaluations).to.equal(2);
      });

      it('publishes one change on the domain bus after the commit, and keeps the decisions outside the moved subtree', async () => {
        expect(await canRead(1)).to.equal(true);
        expect(await canRead(2)).to.equal(true);
        expect(model.evaluations).to.equal(2);

        await reparent(Project, ['p1'], 'o2');
        await ticks();

        expect(published).to.have.length(1);
        expect(published[0].inTx).to.equal(false);
        expect(published[0].change).to.deep.include({ domain: 'root', tags: ['scope:project:p1'], actor: { type: SYSTEM.type, id: SYSTEM.id } });
        expect(await canRead(1), 'task 1 is below project p1').to.equal(false);
        expect(await canRead(2)).to.equal(true);
        expect(model.evaluations, 'only task 1 is evaluated again: task 2 is not below project p1').to.equal(3);
      });

      it('drops a decision two levels below the moved row', async () => {
        expect(await canRead(1, bob)).to.equal(true);
        expect(await canRead(1, bob)).to.equal(true);
        expect(model.evaluations).to.equal(1);

        await reparent(Org, ['o1'], 'r2');
        await ticks();

        expect(tagsPublished()).to.deep.equal([['scope:org:o1']]);
        expect(await canRead(1, bob), 'task 1 > project p1 > org o1 left region r1').to.equal(false);
      });

      it('an update of a @Parent column publishes only when the value changed', async () => {
        await Task.update({ project_id: 'p1' }).where('id', 1);
        await ticks();
        expect(published, 'the same parent, and the inserts before it, are no move').to.deep.equal([]);

        expect(await canRead(1)).to.equal(true);
        await Task.update({ project_id: 'p3' }).where('id', 1);
        await ticks();

        expect(tagsPublished()).to.deep.equal([['scope:task:1']]);
        expect(await canRead(1)).to.equal(false);
      });

      it("a model's own update() publishes the row it moved", async () => {
        const [row] = await Task.query().where('id', 1);
        Object.assign(row, { project_id: 'p3' });
        await row.update();
        await ticks();

        expect(tagsPublished()).to.deep.equal([['scope:task:1']]);
      });

      it('an upsert through the model publishes the row it moved, not the row it kept', async () => {
        await Project.insert({ id: 'p1', org_id: 'o2' }, InsertBehaviour.InsertOrUpdate);
        await Project.insert({ id: 'p2', org_id: 'o1' }, InsertBehaviour.InsertOrUpdate);
        await ticks();

        expect(tagsPublished()).to.deep.equal([['scope:project:p1']]);
        expect(await canRead(1), 'task 1 is below project p1').to.equal(false);
      });

      it('a bulk update publishes one change naming only the rows whose parent changed, and nothing when it reaches none', async () => {
        await Task.insert([{ id: 3, project_id: 'p3' }, { id: 4, project_id: 'p3' }]);
        await Task.update({ project_id: 'p3' }).where('project_id', 'p9');
        await ticks();
        expect(published, 'no row reached').to.deep.equal([]);

        expect(await canRead(2)).to.equal(true);
        await Task.update({ project_id: 'p3' }).whereIn('id', [1, 2, 3, 4]);
        await ticks();

        expect(published).to.have.length(1);
        expect(published[0].change.tags).to.have.members(['scope:task:1', 'scope:task:2']);
        expect(await canRead(2)).to.equal(false);
      });

      it('a rolled-back move publishes nothing and the cached decision stays', async () => {
        expect(await canRead(1)).to.equal(true);
        try {
          await driver.transaction(async () => {
            await Task.update({ project_id: 'p3' }).where('id', 1);
            throw new Error('roll back');
          });
        } catch (e) {
          expect((e as Error).message).to.equal('roll back');
        }
        await ticks();

        expect(published).to.deep.equal([]);
        expect(await canRead(1)).to.equal(true);
        expect(model.evaluations).to.equal(1);
      });

      it("inside a caller's transaction a nested move publishes after the outermost commit, and a savepoint rolled back publishes nothing", async () => {
        let insideOuter: number | undefined;
        await driver.transaction(async () => {
          await driver.transaction(async () => {
            await Task.update({ project_id: 'p3' }).where('id', 1);
          });
          try {
            await driver.transaction(async () => {
              await Task.update({ project_id: 'p3' }).where('id', 2);
              throw new Error('roll back the savepoint');
            });
          } catch (e) {
            expect((e as Error).message).to.equal('roll back the savepoint');
          }
          await ticks();
          insideOuter = published.length;
        });
        await ticks();

        expect(insideOuter, 'nothing is published before the outermost commit').to.equal(0);
        expect(published.map((p) => [p.change.tags, p.inTx])).to.deep.equal([[['scope:task:1'], false]]);
      });

      it('names each moved row up to 1000 and publishes * past that', async () => {
        const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'task', id: String(i) }));
        await driver.transaction(async () => {
          await publishMoved(driver, refs(0));
          await publishMoved(driver, refs(1000));
          await publishMoved(driver, refs(1001));
        });
        await ticks();

        expect(published.map((p) => p.change.tags.length)).to.deep.equal([1000, 1]);
        expect(published[1].change.tags).to.deep.equal(['*']);
      });

      describe('before the domain booted', () => {
        beforeEach(async () => {
          await testHost.resetRoot();
        });

        it('publishes on the bus authz.bus.service names, as the boot would pick it', async () => {
          const named = new RecordingChangeBus();
          const last = new RecordingChangeBus();
          undo.push(testHost.registerInRoot(ChangeBus, testHost.named('MoveBus', testHost.instance(named))));
          undo.push(testHost.registerInRoot(ChangeBus, testHost.instance(last)));
          setConfig(['authz', 'bus', 'service'], 'MoveBus');

          await reparent(Project, ['p1'], 'o2');
          await ticks();

          expect(named.published.map((c) => c.tags)).to.deep.equal([['scope:project:p1']]);
          expect(last.published, 'the last registered bus hears nothing').to.deep.equal([]);
          expect((await testHost.domains()).resolved('root'), 'a move does not boot the domain').to.equal(undefined);
        });

        it('with a bus name that resolves to nothing logs one error per statement, and the move stands', async () => {
          setConfig(['authz', 'bus', 'service'], 'NoSuchBus');
          await Task.insert({ id: 3, project_id: 'p1' });
          const error = sinon.stub(ormLog(), 'error');
          try {
            await Task.update({ project_id: 'p3' }).whereIn('id', [1, 2, 3]);
            await ticks();
            const ours = error.getCalls().filter((c) => String(c.args[1]).startsWith('authz-orm:'));
            expect(ours.map((c) => c.args[0])).to.have.length(1);
            expect(ours[0].args[0]).to.deep.include({ step: 'publishing the move' });
          } finally {
            error.restore();
          }
          expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:') && l.includes('>project:'))).to.deep.equal(['task:1>project:p3@1', 'task:2>project:p3@1', 'task:3>project:p3@1']);
        });
      });
    });
  }
});
