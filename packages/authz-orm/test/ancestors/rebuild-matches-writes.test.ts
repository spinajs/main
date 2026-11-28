import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { Archived, SoftDelete } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import { AncestorsRebuildCommand } from '../../src/cli/commands/ancestors-rebuild.js';
import { AncestorsVerifyCommand } from '../../src/cli/commands/ancestors-verify.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> }; destroy(pk: unknown): Promise<unknown> };

describe('authz:ancestors-rebuild writes what the write observer wrote, for one type per table', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let out: string[];
      let log: sinon.SinonStub;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        out = [];
        log = sinon.stub(console, 'log').callsFake((...a: unknown[]) => void out.push(a.join(' ')));
      });

      afterEach(async () => {
        log.restore();
        process.exitCode = undefined;
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const rebuild = () => Object.assign(new AncestorsRebuildCommand(), { Orm: db.orm }).execute();
      const verify = () => Object.assign(new AncestorsVerifyCommand(), { Orm: db.orm }).execute();

      it('agrees row for row for the kinds of model listed here, and removes what the writes left stale', async () => {
        // A model with no parents.
        const Org = (await db.define({ name: 'Org', columns: {}, decorate: (c) => AccessResource('org')(c) }, dialect)) as M;
        // A typed parent.
        const Project = (await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect)) as M;
        // Two parents, one of its own type.
        const Folder = (await db.define({ name: 'Folder', columns: { project_id: 'TEXT', parent_id: 'TEXT' }, decorate: (c, p) => { AccessResource('folder')(c); Parent('project')(p, 'project_id'); Parent('folder', { nullable: true })(p, 'parent_id'); } }, dialect)) as M;
        // Type 'document' on class Doc_* and table doc_*; a parent type no model registers; soft-deleted and archived rows.
        const Doc = (await db.define(
          {
            name: 'Doc',
            columns: { folder_id: 'TEXT', region_id: 'TEXT', deleted_at: 'TEXT', archived_at: 'TEXT' },
            decorate: (c, p) => {
              AccessResource('document')(c);
              Parent('folder')(p, 'folder_id');
              Parent('region', { nullable: true })(p, 'region_id');
              (SoftDelete() as PropertyDecorator)(p, 'deleted_at');
              (Archived() as PropertyDecorator)(p, 'archived_at');
            },
          },
          dialect,
        )) as M;
        // A second class of the same type on the same table.
        const DocView = (await db.define({ name: 'DocView', columns: {}, table: db.table(Doc), decorate: (c, p) => { AccessResource('document')(c); Parent('folder')(p, 'folder_id'); } }, dialect)) as M;

        await Org.insert([{ id: 'o1' }, { id: 'o2' }]);
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o2' }, { id: 'p3', org_id: 'o1' }]);
        await Folder.insert({ id: 'f1', project_id: 'p1', parent_id: null });
        await Folder.insert({ id: 'f2', project_id: 'p1', parent_id: 'f1' });
        await Doc.insert({ id: 'd1', folder_id: 'f2', region_id: 'r1' });
        // A parent row that does not exist.
        await Doc.insert({ id: 'd2', folder_id: 'f404', region_id: null });
        await Doc.insert({ id: 'd3', folder_id: 'f1', region_id: null });
        await Doc.insert({ id: 'd4', folder_id: 'f2', region_id: null });
        await DocView.insert({ id: 'd5', folder_id: 'f1' });
        await Doc.destroy('d3');
        await Doc.update({ archived_at: '2026-01-01T00:00:00Z' }).where('id', 'd4');
        await Folder.update({ project_id: 'p2' }).where('id', 'f1');
        await Project.update({ org_id: 'o2' }).where('id', 'p3');
        await Project.destroy('p3');

        const driver = db.driver(dialect);
        const written = await ancestorLinks(driver);
        expect(written, 'the soft-deleted and the archived row keep their links').to.include.members(['document:d3>folder:f1@1', 'document:d4>folder:f2@1']);
        expect(written).to.include.members(['document:d1>region:r1@1', 'document:d5>project:p2@2', 'document:d5>org:o2@3', 'folder:f2>org:o2@3']);
        expect(written.filter((l) => l.startsWith('org:') || l.startsWith('project:p3') || l.startsWith('document:d2'))).to.deep.equal([]);

        // A deleted row and an old parent, of declared types.
        await insertLinks(driver, ['project:p9>org:o1@1', 'folder:f1>project:p1@1']);
        await rebuild();
        expect(await ancestorLinks(driver)).to.deep.equal(written);
        out.length = 0;
        await verify();
        expect(out).to.deep.equal(['org: ok', 'project: ok', 'folder: ok', 'document: ok']);
      });

      it('agrees for a type whose first class on a table declares no @Parent', async () => {
        const Org = (await db.define({ name: 'Org', columns: {}, decorate: (c) => AccessResource('org')(c) }, dialect)) as M;
        const Project = (await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect)) as M;
        const Doc = (await db.define({ name: 'Doc', columns: { project_id: 'TEXT' }, decorate: (c) => AccessResource('doc')(c) }, dialect)) as M;
        const DocInProject = (await db.define({ name: 'DocInProject', columns: {}, table: db.table(Doc), decorate: (c, p) => { AccessResource('doc')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;

        await Org.insert([{ id: 'o1' }, { id: 'o2' }]);
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o2' }]);
        await DocInProject.insert({ id: 'd1', project_id: 'p1' });
        await DocInProject.insert({ id: 'd2', project_id: 'p1' });
        await DocInProject.update({ project_id: 'p2' }).where('id', 'd2');

        const driver = db.driver(dialect);
        const written = await ancestorLinks(driver);
        expect(written).to.include.members(['doc:d1>project:p1@1', 'doc:d1>org:o1@2', 'doc:d2>project:p2@1', 'doc:d2>org:o2@2']);

        await rebuild();
        expect(await ancestorLinks(driver)).to.deep.equal(written);
        out.length = 0;
        await verify();
        expect(out).to.deep.equal(['org: ok', 'project: ok', 'doc: ok']);
      });

      it('keeps the links to a parent whose class declares no @Parent, and to a soft-deleted parent', async () => {
        const Org = (await db.define({ name: 'Org', columns: { deleted_at: 'TEXT' }, decorate: (c, p) => { AccessResource('org')(c); (SoftDelete() as PropertyDecorator)(p, 'deleted_at'); } }, dialect)) as M;
        const Project = (await db.define(
          {
            name: 'Project',
            columns: { org_id: 'TEXT', deleted_at: 'TEXT' },
            decorate: (c, p) => {
              AccessResource('project')(c);
              Parent('org')(p, 'org_id');
              (SoftDelete() as PropertyDecorator)(p, 'deleted_at');
            },
          },
          dialect,
        )) as M;
        const Task = (await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;

        await Org.insert([{ id: 'o1' }, { id: 'o2' }]);
        await Org.destroy('o2');
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o1' }, { id: 'p3', org_id: 'o2' }]);
        await Task.insert({ id: 't1', project_id: 'p1' });
        await Project.destroy('p2');
        await Task.insert({ id: 't2', project_id: 'p2' });

        const driver = db.driver(dialect);
        const written = await ancestorLinks(driver);
        expect(written).to.deep.equal(['project:p1>org:o1@1', 'project:p2>org:o1@1', 'project:p3>org:o2@1', 'task:t1>org:o1@2', 'task:t1>project:p1@1', 'task:t2>org:o1@2', 'task:t2>project:p2@1']);

        await rebuild();
        expect(await ancestorLinks(driver)).to.deep.equal(written);
        out.length = 0;
        await verify();
        expect(out).to.deep.equal(['org: ok', 'project: ok', 'task: ok']);
      });

      /** The links the writes left, after verify found no drift and a rebuild of the quiet database wrote the same rows. */
      const writesAgreeWithRebuild = async (): Promise<string[]> => {
        const driver = db.driver(dialect);
        const written = await ancestorLinks(driver);
        out.length = 0;
        await verify();
        expect(out.filter((l) => !l.endsWith(': ok')), 'authz:ancestors-verify').to.deep.equal([]);
        await rebuild();
        expect(await ancestorLinks(driver), 'a rebuild of the quiet database').to.deep.equal(written);
        return written;
      };

      const chain = async () => ({
        Org: (await db.define({ name: 'Org', columns: {}, decorate: (c) => AccessResource('org')(c) }, dialect)) as M,
        Project: (await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect)) as M,
        Task: (await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M,
      });
      const tasks = (links: readonly string[]): string[] => links.filter((l) => l.startsWith('task:'));

      it('a row created with the id of a deleted parent inherits the children whose column names it, on both paths alike', async () => {
        const { Org, Project, Task } = await chain();
        await Org.insert([{ id: 'o1' }, { id: 'o2' }]);
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o1' }, { id: 'p3', org_id: 'o1' }]);
        await Task.insert([{ id: 't1', project_id: 'p1' }, { id: 't2', project_id: 'p2' }]);
        await Project.destroy('p1');
        expect((await writesAgreeWithRebuild()).filter((l) => l.startsWith('task:t1'))).to.deep.equal([]);

        // Untracked: project:p3 keeps its own links, which must not reach a child through the missing row.
        await db.raw(`DELETE FROM ${TestDb.quote(db.table(Project), dialect)} WHERE ${TestDb.quote('id', dialect)} = 'p3'`, [], dialect);
        await Task.update({ project_id: 'p1' }).where('id', 't2');
        await Task.insert({ id: 't3', project_id: 'p3' });
        const driver = db.driver(dialect);
        const written = await ancestorLinks(driver);
        expect(tasks(written)).to.deep.equal([]);
        expect(written).to.include('project:p3>org:o1@1');
        await rebuild();
        expect(await ancestorLinks(driver)).to.deep.equal(written.filter((l) => l !== 'project:p3>org:o1@1'));

        await Project.insert({ id: 'p1', org_id: 'o2' });
        expect(tasks(await writesAgreeWithRebuild())).to.deep.equal(['task:t1>org:o2@2', 'task:t1>project:p1@1', 'task:t2>org:o2@2', 'task:t2>project:p1@1']);
      });

      it('a child written before its parent is linked when the parent is inserted, in one transaction or not', async () => {
        const { Org, Project, Task } = await chain();
        // Two @Parent columns that name one type.
        const Edge = (await db.define({ name: 'Edge', columns: { from_id: 'TEXT', to_id: 'TEXT' }, decorate: (c, p) => { AccessResource('edge')(c); Parent('project')(p, 'from_id'); Parent('project')(p, 'to_id'); } }, dialect)) as M;
        // A second class of the child type, on a table of its own.
        const ArchivedTask = (await db.define({ name: 'ArchivedTask', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        await Org.insert({ id: 'o1' });
        await Project.insert({ id: 'p1', org_id: 'o1' });

        await Task.insert({ id: 't9', project_id: 'p9' });
        await ArchivedTask.insert({ id: 'a9', project_id: 'p9' });
        await Edge.insert({ id: 'e1', from_id: 'p1', to_id: 'p9' });
        expect((await writesAgreeWithRebuild()).filter((l) => l.startsWith('task:') || l.startsWith('edge:'))).to.deep.equal(['edge:e1>org:o1@2', 'edge:e1>project:p1@1']);
        await Project.insert({ id: 'p9', org_id: 'o1' });
        expect((await writesAgreeWithRebuild()).filter((l) => l.startsWith('task:t9') || l.startsWith('task:a9') || l.startsWith('edge:'))).to.deep.equal(['edge:e1>org:o1@2', 'edge:e1>project:p1@1', 'edge:e1>project:p9@1', 'task:a9>org:o1@2', 'task:a9>project:p9@1', 'task:t9>org:o1@2', 'task:t9>project:p9@1']);

        const driver = db.driver(dialect);
        await driver.transaction(async () => {
          await Task.insert({ id: 't8', project_id: 'p8' });
          await Project.insert({ id: 'p8', org_id: 'o1' });
        });
        expect((await writesAgreeWithRebuild()).filter((l) => l.startsWith('task:t8'))).to.deep.equal(['task:t8>org:o1@2', 'task:t8>project:p8@1']);

        // A root parent, which declares no @Parent itself.
        await Project.insert({ id: 'p7', org_id: 'o7' });
        await Task.insert({ id: 't7', project_id: 'p7' });
        await Org.insert({ id: 'o7' });
        expect((await writesAgreeWithRebuild()).filter((l) => l.includes('o7'))).to.deep.equal(['project:p7>org:o7@1', 'task:t7>org:o7@2']);
      });

      it("a parent deleted with its children's column cleared passes nothing to a reused id", async () => {
        const { Org, Project, Task } = await chain();
        await Org.insert([{ id: 'o1' }, { id: 'o2' }]);
        await Project.insert({ id: 'p1', org_id: 'o1' });
        await Task.insert({ id: 't1', project_id: 'p1' });
        await Project.destroy('p1');
        // What a foreign key with ON DELETE SET NULL does.
        await db.raw(`UPDATE ${TestDb.quote(db.table(Task), dialect)} SET ${TestDb.quote('project_id', dialect)} = NULL WHERE ${TestDb.quote('id', dialect)} = 't1'`, [], dialect);
        await Project.insert({ id: 'p1', org_id: 'o2' });
        expect(tasks(await writesAgreeWithRebuild())).to.deep.equal([]);
      });
    });
  }
});
