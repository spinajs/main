import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';
import { DecisionLog, PolicyHashSource } from '@spinajs/authz';
import type { DecisionRecord } from '@spinajs/authz';
import { StaticModel, testHost, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { createHash } from 'node:crypto';

import { IRPolicyHashSource, readPolicyVersion } from '../../src/index.js';
import { createChangeLogTables, dropChangeLogTables } from '../support/changelog.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;
const alice = userPrincipal('alice');
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

class Sink extends DecisionLog {
  readonly records: DecisionRecord[] = [];
  write(r: DecisionRecord[]) {
    this.records.push(...r);
    return Promise.resolve();
  }
}

type Seam = { write(h: string, c: string): Promise<boolean>; probe(h: string): Promise<void> };
const seam = () => IRPolicyHashSource.prototype as unknown as Seam;

describe('IRPolicyHashSource (sqlite)', function () {
  this.timeout(60000);
  let db: TestDb;
  let sink: Sink;

  before(async () => {
    db = await TestDb.open();
  });
  after(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await createChangeLogTables(db, 'sqlite');
    testHost.config().set(['authz', 'permissions'], { 'doc:read': {} });
    testHost.config().set(['authz', 'decisionLog'], { batch: { size: 1 } });
    sink = new Sink();
  });
  afterEach(async () => {
    sinon.restore();
    // resetHost disposes the domains, uncaches the root service, removes root registrations and resets the config.
    await testHost.resetHost();
    // The source is a process singleton: a fresh one per test, or snapshots and the per-hash write map leak across tests.
    DI.RootContainer.uncache(PolicyHashSource);
    DI.RootContainer.uncache(IRPolicyHashSource);
    await dropChangeLogTables(db, 'sqlite');
  });

  const source = async () => (await DI.resolve(PolicyHashSource)) as IRPolicyHashSource;
  // Registers once per test: activate() appends the model name to authz.models, so a re-boot must not call it again.
  const arm = (withSink = true) => {
    if (withSink) testHost.registerInRoot(DecisionLog, testHost.instance(sink));
    testHost.activate(DI.RootContainer, 'root', new StaticModel({ name: 'sm', votes: {} }));
  };
  const boot = async () => ({ service: await (await testHost.domains()).service('root'), source: await source() });
  const bootRoot = async (withSink = true) => {
    arm(withSink);
    return boot();
  };
  /** Disposes the root service; the registrations and the config stay, so `boot()` boots the same domain again. */
  const reboot = async () => {
    await testHost.resetRoot();
    return boot();
  };

  it('is the registered PolicyHashSource', async () => {
    expect(await DI.resolve(PolicyHashSource)).to.be.instanceOf(IRPolicyHashSource);
  });

  it("'record': the domain's hash is known when its service resolves, records cite it and the IR is stored once", async () => {
    const { service, source } = await bootRoot();
    const snap = source.current('root')!;
    expect(snap.hash).to.match(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(snap.canonical).digest('hex')).to.equal(snap.hash);
    expect(await snap.recorded).to.equal(true);
    expect((await readPolicyVersion(snap.hash))!.ir).to.equal(snap.canonical);
    await service.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    await tick();
    expect(sink.records.map((r) => r.policyHash)).to.deep.equal([snap.hash]);
  });

  it('a second domain with the same policy does not write again', async () => {
    const spy = sinon.spy(seam(), 'write');
    const { source } = await bootRoot();
    const d = await testHost.domains();
    const c = d.create('child');
    c.register(testHost.instance(sink)).as(DecisionLog);
    await d.service('child');
    expect(source.current('child')!.hash).to.equal(source.current('root')!.hash);
    expect(await source.current('child')!.recorded).to.equal(true);
    expect(spy.callCount).to.equal(1);
  });

  it("'hash': records cite the hash, nothing is written", async () => {
    testHost.config().set(['authz', 'changelog', 'policyVersion'], 'hash');
    const { source } = await bootRoot();
    const snap = source.current('root')!;
    expect(await snap.recorded).to.equal(undefined);
    expect(await readPolicyVersion(snap.hash)).to.equal(undefined);
  });

  it("'off': nothing is compiled", async () => {
    testHost.config().set(['authz', 'changelog', 'policyVersion'], 'off');
    const { source } = await bootRoot();
    expect(source.current('root')).to.equal(undefined);
  });

  it('no decision log: nothing is compiled', async () => {
    const { source } = await bootRoot(false);
    expect(source.current('root')).to.equal(undefined);
  });

  it("a domain that re-boots with mode 'off' has no snapshot", async () => {
    const first = await bootRoot();
    expect(first.source.current('root')).to.not.equal(undefined);
    // Settled before afterEach drops the table, or its retries would reach the next test's write spy.
    expect(await first.source.current('root')!.recorded).to.equal(true);
    testHost.config().set(['authz', 'changelog', 'policyVersion'], 'off');
    const again = await reboot();
    expect(again.source).to.equal(first.source);
    expect(again.source.current('root')).to.equal(undefined);
    expect(again.source.policyHash('root')).to.equal(undefined);
  });

  it('an unreachable store degrades the process to hash mode with one warning; the hash is still cited', async () => {
    await dropChangeLogTables(db, 'sqlite');
    // The suites load @spinajs/log, so the warning goes through the registered Log of ormLog().
    const warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
    const write = sinon.spy(seam(), 'write');
    const { source } = await bootRoot();
    expect(await source.current('root')!.recorded).to.equal(undefined);
    expect(write.callCount).to.equal(0);
    expect(source.policyHash('root')).to.match(/^[0-9a-f]{64}$/);
    await reboot();
    expect(write.callCount).to.equal(0);
    expect(warn.getCalls().filter((c) => String(c.args[1]).includes('authz_policy_version')).length).to.equal(1);
  });

  it('a write that fails after a successful probe is retried, then logged; the hash is still cited', async () => {
    const src = await source();
    src.retryDelaysMs = [1, 1];
    const write = sinon.stub(seam(), 'write').rejects(new Error('connection reset'));
    const { source: booted } = await bootRoot();
    expect(booted).to.equal(src);
    expect(await booted.current('root')!.recorded).to.equal(undefined);
    expect(write.callCount).to.equal(3);
    expect(booted.policyHash('root')).to.match(/^[0-9a-f]{64}$/);
  });

  it('a toIR that throws leaves the domain without a hash, and the boot succeeds', async () => {
    testHost.registerInRoot(DecisionLog, testHost.instance(sink));
    const bad = new StaticModel({ name: 'bad', votes: {} }) as StaticModel & { toIR(): never };
    bad.toIR = () => {
      throw new Error('cannot compile');
    };
    testHost.activate(DI.RootContainer, 'root', bad);
    await (await testHost.domains()).service('root');
    expect((await source()).policyHash('root')).to.equal(undefined);
  });
});
