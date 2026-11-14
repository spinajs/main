import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthorizationModel, ModelListPlan, PermissionDef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { RlsCommand } from '../../src/cli/commands/rls.js';
import { AccessResource, Owner } from '../../src/index.js';
import { RlsPlanSource } from '../../src/plan/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

class Source extends RlsPlanSource {
  readonly model = 'fake';
  static read: ModelListPlan = { kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [] } }], deny: [] };
  plan(_m: AuthorizationModel, permission: PermissionDef): ModelListPlan {
    return permission.name === 'memo:read' ? Source.read : { kind: 'all' };
  }
}

describe('authz:rls', function () {
  this.timeout(60000);
  let db: TestDb;
  let dir: string;
  const out: string[] = [];
  const undo: (() => void)[] = [];

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'authz-rls-'));
    out.length = 0;
    await db.define({ name: 'Memo', columns: { author_id: 'TEXT' }, decorate: (c, p) => (AccessResource('memo', { rls: true })(c), Owner()(p, 'author_id')) });
    undo.push(testHost.registerInRoot(RlsPlanSource, Source));
    const service = await (await testHost.domains()).service('root');
    sinon.stub(service, 'models').returns([{ name: 'fake', applies: () => true } as unknown as AuthorizationModel]);
  });

  afterEach(async () => {
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    DI.RootContainer.uncache(RlsPlanSource);
    await testHost.resetRoot();
    await db.clear();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const run = async (opts: Record<string, string>) => {
    const cmd = Object.assign(new RlsCommand(), { Orm: db.orm, Container: DI.RootContainer });
    sinon.stub(cmd as unknown as { out(l: string): void }, 'out').callsFake((l: string) => void out.push(l));
    sinon.stub(cmd as unknown as { fail(l: string): void }, 'fail').callsFake((l: string) => void out.push(`FAIL ${l}`));
    await cmd.execute({ out: dir, ...opts });
  };

  it('writes one migration with the policies of every rls table', async () => {
    await run({ bypassRole: 'app_system' });
    const files = readdirSync(dir);
    expect(files).to.have.length(1);
    expect(files[0]).to.match(/^AuthzRls_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}\.ts$/);
    const source = readFileSync(join(dir, files[0]), 'utf8');
    expect(source).to.include('FORCE ROW LEVEL SECURITY');
    expect(source).to.include('spina_memo_read');
    expect(source).to.include('TO \\"app_system\\"');
    expect(out[0]).to.equal(`wrote ${join(dir, files[0])}`);
  });

  it('writes nothing and fails on AUTHZ020', async () => {
    Source.read = { kind: 'terms', permit: [{ op: 'nobody.renders', args: {} }], deny: [] };
    try {
      await run({});
    } finally {
      Source.read = { kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [] } }], deny: [] };
    }
    expect(readdirSync(dir)).to.deep.equal([]);
    expect(out.some((l) => l.startsWith('error AUTHZ020'))).to.equal(true);
    expect(out.at(-1)).to.match(/^FAIL authz:rls: AUTHZ020, nothing written/);
  });
});
