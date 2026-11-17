import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyHash } from '@spinajs/authz-ir';
import type { PolicyIR } from '@spinajs/authz-ir';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { CompileCommand } from '../../src/cli/commands/compile.js';
import { readPolicyVersion } from '../../src/index.js';
import { createChangeLogTables, dropChangeLogTables } from '../support/changelog.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

describe('authz:compile', function () {
  this.timeout(60000);
  let db: TestDb;
  let dir: string;
  const out: string[] = [];

  before(async () => {
    db = await TestDb.open();
  });
  after(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'authz-compile-'));
    out.length = 0;
    await createChangeLogTables(db, 'sqlite');
    testHost.activate(DI.RootContainer, 'root', new StaticModel({ name: 'sm', votes: {} }));
  });
  afterEach(async () => {
    sinon.restore();
    await testHost.resetHost();
    await dropChangeLogTables(db, 'sqlite');
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const file = () => join(dir, 'authz.ir.json');
  const run = async (opts: Record<string, unknown>) => {
    const cmd = Object.assign(new CompileCommand(), { Orm: db.orm, Container: DI.RootContainer });
    sinon.stub(cmd as unknown as { out(l: string): void }, 'out').callsFake((l: string) => void out.push(l));
    // The real fail() prints and sets the exit code; the fake keeps the exit code, which the tests assert.
    sinon.stub(cmd as unknown as { fail(l: string): void }, 'fail').callsFake((l: string) => {
      out.push(`FAIL ${l}`);
      process.exitCode = 1;
    });
    await cmd.execute({ out: file(), ...opts });
  };
  const hashLine = () => out.find((l) => l.startsWith('policyHash '))!.split(' ')[1];
  const failed = (text: string) => out.some((l) => l.startsWith('FAIL') && l.includes(text));

  it('writes the policy IR, pretty-printed, and prints its hash', async () => {
    await run({});
    const text = readFileSync(file(), 'utf8');
    expect(text).to.contain('\n  "');
    expect(policyHash(JSON.parse(text) as PolicyIR)).to.equal(hashLine());
    expect(out).to.include(`wrote ${file()}`);
  });

  it('--check passes on a current file, fails on a stale or missing one and writes nothing', async () => {
    await run({});
    out.length = 0;
    await run({ check: true });
    expect(process.exitCode).to.equal(undefined);
    writeFileSync(file(), JSON.stringify({ version: 1, types: {}, permissions: {}, caveats: {}, combine: { default: { algorithm: 'deny-overrides' } }, principal: { ceiling: true, delegation: true, ancestry: 'parent', roles: {} }, opaque: [] }));
    await run({ check: true });
    expect(process.exitCode).to.equal(1);
    expect(failed('stale (hash')).to.equal(true);
  });

  it('--check reports why: a missing file, invalid JSON and valid JSON that is not a policy IR', async () => {
    await run({ check: true });
    expect(failed('stale (missing)')).to.equal(true);
    out.length = 0;
    writeFileSync(file(), '{ not json');
    await run({ check: true });
    expect(failed('stale (not valid JSON)')).to.equal(true);
    out.length = 0;
    writeFileSync(file(), JSON.stringify({ version: 1 }));
    await run({ check: true });
    expect(failed('stale (invalid IR')).to.equal(true);
    expect(process.exitCode).to.equal(1);
  });

  it('--record stores the policy version; --record with --live is refused', async () => {
    await run({ record: true });
    expect(await readPolicyVersion(hashLine())).to.not.equal(undefined);
    out.length = 0;
    await run({ record: true, live: true });
    expect(process.exitCode).to.equal(1);
  });

  it('--live says its hash is not a policy version', async () => {
    await run({ live: true });
    expect(out.find((l) => l.startsWith('policyHash '))).to.contain('effective policy');
  });

  it('the file feeds authz:export and authz:verify unchanged (a bare PolicyIR)', async () => {
    await run({});
    const ir = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(ir).sort()).to.deep.equal(['caveats', 'combine', 'opaque', 'permissions', 'principal', 'types', 'version']);
  });
});
