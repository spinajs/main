import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { DecisionLogTap, inputsHash } from '../../src/host/decision-log-tap.js';
import type { DecisionLogOptions } from '../../src/host/decision-log-tap.js';
import { DecisionLog, DecisionTraceContext, FALSE, PolicyHashSource, TRUE } from '../../src/index.js';
import type { DecisionRecord, DecisionRequest, EvaluationContext, ResourceFilter, Vote } from '../../src/index.js';
import { FakeAdapter, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

class RecordingSink extends DecisionLog {
  readonly batches: DecisionRecord[][] = [];
  fail = false;

  write(records: DecisionRecord[]): Promise<void> {
    if (this.fail) return Promise.reject(new Error('sink down'));
    this.batches.push(records);
    return Promise.resolve();
  }

  get records(): DecisionRecord[] {
    return this.batches.flat();
  }
}

class VersionedModel extends StaticModel {
  version(): string {
    return 'v3';
  }
}

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice');
const vote = (permitWhen: ResourceFilter): Vote => ({ model: 'm', permitWhen, denyWhen: FALSE, cacheable: true });
const byEnv = () => new VersionedModel('m', { vote: (req: DecisionRequest) => vote(req.env?.ok === true ? TRUE : FALSE) });
const doc = { type: 'doc', id: 'd1' };

function setup(options: Partial<DecisionLogOptions> = {}, authorizer: Partial<AuthorizerOptions> = {}) {
  const sink = new RecordingSink();
  const log = new RecordingLog();
  const tap = new DecisionLogTap({ domain: 'root', sink, mode: 'deny', allowSampleRate: 0, captureInputs: false, batch: { size: 100, flushMs: 60_000 }, log, ...options });
  const a = new Authorizer({ domain: 'root', registry, models: [byEnv()], adapters: [new FakeAdapter(['doc'], { nodes: { 'doc:d1': null } })], clock: fakeClock().clock, taps: [tap], ...authorizer });
  return { a, tap, sink, log };
}

describe('DecisionLogTap', () => {
  it("mode 'deny' (the default) writes one record per denial, keyed by the decision's id", async () => {
    const { a, tap, sink } = setup();
    await a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: true } });
    const denied = await a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } });
    await tap.flush();
    expect(sink.records).to.have.length(1);
    const [r] = sink.records;
    expect(r).to.deep.include({ id: denied.id, at: '2026-10-01T12:00:00.000Z', domain: 'root', principal: 'user:alice', permission: 'doc:read', resource: doc, allowed: false, reason: 'no_access', cached: false, policyHash: 'unknown', modelVersions: { m: 'v3' } });
    expect(r.inputsHash).to.match(/^[0-9a-f]{64}$/);
    expect(r).to.not.have.property('inputs');
    expect(r).to.not.have.property('traceId');
  });

  it("mode 'all' writes allows too, 'sampled' a share of them and every denial, 'off' nothing", async () => {
    const all = setup({ mode: 'all' });
    await all.a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: true } });
    const rolls = [0.5, 0.001];
    const sampled = setup({ mode: 'sampled', allowSampleRate: 0.01, random: () => rolls.shift() ?? 1 });
    for (const ok of [true, true, false]) await sampled.a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok } });
    const off = setup({ mode: 'off' });
    await off.a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } });
    await Promise.all([all.tap.flush(), sampled.tap.flush(), off.tap.flush()]);
    expect(all.sink.records.map((r) => r.allowed)).to.deep.equal([true]);
    expect(sampled.sink.records.map((r) => r.allowed)).to.deep.equal([true, false]);
    expect(off.sink.records).to.deep.equal([]);
  });

  it('writes a full batch at once, the rest after flushMs, and a failed write is logged without failing the check', async () => {
    const { a, sink } = setup({ batch: { size: 2, flushMs: 5 } });
    for (let i = 0; i < 3; i++) await a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } });
    expect(sink.batches.map((b) => b.length)).to.deep.equal([2]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sink.batches.map((b) => b.length)).to.deep.equal([2, 1]);

    const failing = setup();
    failing.sink.fail = true;
    const d = await failing.a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } });
    await failing.tap.flush();
    expect(d.allowed).to.equal(false);
    expect(failing.log.at('error').map((e) => e.error?.message)).to.deep.equal(['sink down']);
  });

  it('hashes the same inputs alike and different inputs apart, whatever order the reads came in', async () => {
    const first = setup();
    const second = setup();
    await first.a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false, ip: '1' } });
    await second.a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ip: '1', ok: false } });
    await second.a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false, ip: '2' } });
    await Promise.all([first.tap.flush(), second.tap.flush()]);
    const [a, b, c] = [...first.sink.records, ...second.sink.records].map((r) => r.inputsHash);
    expect(a).to.equal(b);
    expect(c).to.not.equal(a);

    const req = { principal: alice, permission: 'doc:read', resource: doc } as DecisionRequest;
    const denied = { ...(await setup().a.check({ principal: alice, permission: 'doc:read', resource: doc })) };
    const reads = (attributes: { ref: 'principal'; path: string; value: unknown }[]) => ({ env: {}, attributes, relations: [], modelVersions: {} });
    const x = { ref: 'principal' as const, path: 'x', value: 1 };
    const y = { ref: 'principal' as const, path: 'y', value: 2 };
    expect(inputsHash(req, denied, reads([x, y]), 'p')).to.equal(inputsHash(req, denied, reads([y, x]), 'p'));
    expect(inputsHash(req, denied, reads([x, y]), 'p')).to.not.equal(inputsHash(req, denied, reads([x, y]), 'q'));
  });

  it('keeps the inputs with captureInputs, and takes the policy hash and trace from their ports', async () => {
    const annotated: string[] = [];
    class Trace extends DecisionTraceContext {
      current() {
        return { traceId: 't'.repeat(32), spanId: 's'.repeat(16) };
      }
      annotate(id: string) {
        annotated.push(id);
      }
    }
    class Policy extends PolicyHashSource {
      policyHash(domain: string) {
        return `hash-of-${domain}`;
      }
    }
    const model = new VersionedModel('m', {
      vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
        await ctx.attributes({ type: 'doc', id: 'd1' });
        return vote(req.env?.ok === true ? TRUE : FALSE);
      },
    });
    const { a, tap, sink } = setup({ captureInputs: true, trace: new Trace(), policy: new Policy() }, { models: [model] });
    const d = await a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } });
    await tap.flush();
    const [r] = sink.records;
    expect(r).to.deep.include({ traceId: 't'.repeat(32), spanId: 's'.repeat(16), policyHash: 'hash-of-root' });
    expect(r.inputs).to.deep.equal({ env: { ok: false }, attributes: [{ ref: doc, path: '', value: {} }], relations: [], modelVersions: { m: 'v3' } });
    expect(annotated).to.deep.equal([d.id]);
  });
});
