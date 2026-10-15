import * as chai from 'chai';
import 'mocha';

import { AncestorsRebuildCommand } from '../../src/cli/commands/ancestors-rebuild.js';
import { AncestorsVerifyCommand } from '../../src/cli/commands/ancestors-verify.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  return {
    out,
    err,
    code: () => process.exitCode,
    restore: () => {
      console.log = log;
      console.error = error;
      process.exitCode = exitCode;
    },
  };
}

describe('authz:ancestors-verify / authz:ancestors-rebuild', function () {
  this.timeout(60000);
  let db: TestDb;
  let io: ReturnType<typeof capture>;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await createAncestorTable(db, 'sqlite');
    await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, rows: [{ id: 'p1', org_id: 'o1' }], decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } });
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, rows: [{ id: 't1', project_id: 'p1' }, { id: 't2', project_id: null }], decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    io = capture();
  });

  afterEach(async () => {
    io.restore();
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  const verify = (type?: string) => Object.assign(new AncestorsVerifyCommand(), { Orm: db.orm }).execute(type);
  const rebuild = (type?: string) => Object.assign(new AncestorsRebuildCommand(), { Orm: db.orm }).execute(type);

  it('verify reports missing, extra and wrong-depth rows with exit code 1', async () => {
    await insertLinks(db.driver(), ['task:t1>org:o1@3', 'task:t2>project:p9@1']);
    await verify('task');
    expect(io.out).to.include.members(['task: missing task:t1>project:p1@1', 'task: extra task:t2>project:p9@1']);
    expect(io.out.some((l) => l.startsWith('task: depth task:t1>org:o1 expected 2, found 3'))).to.equal(true);
    expect(io.out[io.out.length - 1]).to.equal('task: 1 missing, 1 extra, 1 wrong depth');
    expect(io.code()).to.equal(1);
  });

  it('rebuild rewrites every registered type; verify then passes with exit code 0', async () => {
    await insertLinks(db.driver(), ['task:t2>project:p9@1']);
    await rebuild();
    expect(await ancestorLinks(db.driver())).to.deep.equal(['project:p1>org:o1@1', 'task:t1>org:o1@2', 'task:t1>project:p1@1']);
    expect(io.out).to.include.members(['project: 1 rows', 'task: 2 rows']);
    io.out.length = 0;
    await verify();
    expect(io.out).to.deep.equal(['project: ok', 'task: ok']);
    expect(io.code()).to.equal(undefined);
  });

  it('verify without a type also reports rows of types no model declares', async () => {
    await rebuild();
    await insertLinks(db.driver(), ['ghost:g1>project:p1@1']);
    io.out.length = 0;
    await verify();
    expect(io.out).to.include('ghost: extra ghost:g1>project:p1@1');
    expect(io.code()).to.equal(1);
  });

  it('an unknown type is a usage error with exit code 1', async () => {
    await verify('nope');
    expect(io.err).to.deep.equal(["authz:ancestors: no @AccessResource model has type 'nope'"]);
    expect(io.code()).to.equal(1);
  });
});
