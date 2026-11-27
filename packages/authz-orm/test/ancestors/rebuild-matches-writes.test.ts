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

describe('authz:ancestors-rebuild writes what the write observer wrote', function () {
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

      it('agrees row for row for every kind of model, and removes what the writes left stale', async () => {
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
        expect(written).to.include.members(['document:d1>region:r1@1', 'document:d2>folder:f404@1', 'document:d5>project:p2@2', 'document:d5>org:o2@3', 'folder:f2>org:o2@3']);
        expect(written.filter((l) => l.startsWith('org:') || l.startsWith('project:p3'))).to.deep.equal([]);

        // A deleted row and an old parent, of declared types.
        await insertLinks(driver, ['project:p9>org:o1@1', 'folder:f1>project:p1@1']);
        await rebuild();
        expect(await ancestorLinks(driver)).to.deep.equal(written);
        out.length = 0;
        await verify();
        expect(out).to.deep.equal(['org: ok', 'project: ok', 'folder: ok', 'document: ok']);
      });
    });
  }
});
