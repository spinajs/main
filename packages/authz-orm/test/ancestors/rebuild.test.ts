import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { ModelBase } from '@spinajs/orm';

import { rebuildFrom, removeNodes } from '../../src/ancestors/rebuild.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

describe('ancestor rebuild', function () {
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
      let Project: typeof ModelBase;
      let Folder: typeof ModelBase;
      let Task: typeof ModelBase;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Project = await db.define(
          {
            name: 'Project',
            columns: { org_id: 'TEXT' },
            rows: [
              { id: 'p1', org_id: 'o1' },
              { id: 'p2', org_id: 'o2' },
            ],
            decorate: (c, p) => {
              AccessResource('project')(c);
              Parent('org')(p, 'org_id');
            },
          },
          dialect,
        );
        Folder = await db.define(
          {
            name: 'Folder',
            columns: { project_id: 'TEXT', parent_id: 'TEXT' },
            rows: [
              { id: 'f1', project_id: 'p1', parent_id: null },
              { id: 'f2', project_id: 'p1', parent_id: 'f1' },
            ],
            decorate: (c, p) => {
              AccessResource('folder')(c);
              Parent('project')(p, 'project_id');
              Parent('folder', { nullable: true })(p, 'parent_id');
            },
          },
          dialect,
        );
        Task = await db.define(
          {
            name: 'Task',
            columns: { id: 'INTEGER', folder_id: 'TEXT' },
            rows: [{ id: 1, folder_id: 'f2' }],
            decorate: (c, p) => {
              AccessResource('task')(c);
              Parent('folder')(p, 'folder_id');
            },
          },
          dialect,
        );
        void Project;
        void Folder;
        void Task;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('rebuildFrom writes the closure of the roots and of every descendant the table knows', async () => {
        const d = db.driver(dialect);
        await rebuildFrom(d, [
          { type: 'project', id: 'p1' },
          { type: 'folder', id: 'f1' },
          { type: 'folder', id: 'f2' },
          { type: 'task', id: '1' },
        ]);
        expect(await ancestorLinks(d)).to.deep.equal(['folder:f1>org:o1@2', 'folder:f1>project:p1@1', 'folder:f2>folder:f1@1', 'folder:f2>org:o1@2', 'folder:f2>project:p1@1', 'project:p1>org:o1@1', 'task:1>folder:f1@2', 'task:1>folder:f2@1', 'task:1>org:o1@3', 'task:1>project:p1@2'].sort());

        // move both folders to p2: the subtree (f2, task 1) follows f1
        await db.raw(`UPDATE "${db.table(Folder)}" SET project_id = 'p2'`, [], dialect);
        await rebuildFrom(d, [{ type: 'project', id: 'p2' }]);
        await rebuildFrom(d, [{ type: 'folder', id: 'f1' }]);
        const links = await ancestorLinks(d);
        expect(links).to.include.members(['folder:f1>project:p2@1', 'folder:f1>org:o2@2', 'task:1>project:p2@2', 'task:1>org:o2@3']);
        expect(links.some((l) => l.includes('>project:p1@') || (l.startsWith('folder:') && l.includes('>org:o1@')) || l.startsWith('task:1>org:o1'))).to.equal(false);
      });

      it('refuses a reparent into its own subtree', async () => {
        const d = db.driver(dialect);
        await rebuildFrom(d, [
          { type: 'folder', id: 'f1' },
          { type: 'folder', id: 'f2' },
        ]);
        await db.raw(`UPDATE "${db.table(Folder)}" SET parent_id = 'f2' WHERE id = 'f1'`, [], dialect);
        let err: unknown;
        try {
          await rebuildFrom(d, [{ type: 'folder', id: 'f1' }]);
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.match(/cycle/);
      });

      it('removeNodes drops the rows of the deleted and turns their undeleted children into roots', async () => {
        const d = db.driver(dialect);
        await insertLinks(d, ['project:p1>org:o1@1', 'folder:f1>project:p1@1', 'folder:f1>org:o1@2', 'folder:f2>folder:f1@1', 'folder:f2>project:p1@1', 'folder:f2>org:o1@2', 'task:1>folder:f2@1', 'task:1>folder:f1@2', 'task:1>project:p1@2', 'task:1>org:o1@3']);
        await db.raw(`DELETE FROM "${db.table(Folder)}" WHERE id = 'f1'`, [], dialect);
        await removeNodes(d, [{ type: 'folder', id: 'f1' }]);
        expect(await ancestorLinks(d)).to.deep.equal(['folder:f2>org:o1@2', 'folder:f2>project:p1@1', 'project:p1>org:o1@1', 'task:1>folder:f2@1', 'task:1>org:o1@3', 'task:1>project:p1@2']);
      });
    });
  }
});
