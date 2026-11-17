import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';
import { activeTraceIds, withSpan } from '@spinajs/tracing';
import { useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { DecisionLogTap, inputsHash, inputsHashOf, inputsHashParts } from '../../src/host/decision-log-tap.js';
import type { DecisionLogOptions } from '../../src/host/decision-log-tap.js';
import { DecisionLog, DecisionTraceContext, FALSE, PolicyHashSource, TRUE, authzStorage, resourceKey } from '../../src/index.js';
import type { Decision, DecisionReadSet, DecisionRecord, DecisionRequest, EvaluationContext, ResourceFilter, Vote } from '../../src/index.js';
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
    expect(r.inputs).to.deep.equal({ env: { ok: false }, attributes: [{ ref: doc, path: '', value: {} }], relations: [], modelVersions: { m: 'v3' }, principalState: r.inputs!.principalState, actorState: null });
    expect(r.inputs!.principalState).to.be.a('string');
    expect(annotated).to.deep.equal([d.id]);
  });

  describe('evidence for replay', () => {
    const req: DecisionRequest = { principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } };
    const decision: Decision = { allowed: false, permission: 'doc:read', resource: doc, principal: alice, residual: FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root', id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6a' };
    const reads: DecisionReadSet = { env: { ok: false }, attributes: [{ ref: doc, path: '', value: { a: 1 } }], relations: [{ model: 'm', object: doc, relation: 'owner' }], modelVersions: { m: 'v3' } };
    const tapOf = (options: Partial<DecisionLogOptions> = {}) => setup({ mode: 'all', ...options });
    const recorded = async (tap: DecisionLogTap, sink: RecordingSink): Promise<DecisionRecord> => {
      await tap.flush();
      return sink.records[0];
    };

    it('hashes the same with inputsHashOf over the captured parts', async () => {
      const { tap, sink } = tapOf({ captureInputs: true });
      tap.onDecision(req, decision, reads, { cached: false, durationMs: 1 });
      const r = await recorded(tap, sink);
      const parts = { principal: r.inputs!.principalState, actor: r.inputs!.actorState, permission: r.permission, resource: resourceKey(r.resource), env: r.inputs!.env, attributes: r.inputs!.attributes, relations: r.inputs!.relations, modelVersions: r.modelVersions, policyHash: r.policyHash };
      expect(inputsHashOf(parts)).to.equal(r.inputsHash);
      expect(r.inputsHash).to.equal(inputsHash(req, decision, reads, r.policyHash));
    });

    it('hashes as before the split: records logged earlier keep their inputsHash', () => {
      const p = principal('user', 'alice', { attributes: { email: 'a@b' }, ceiling: { permissions: ['doc:read'] } });
      const bot = principal('agent', 'bot', { source: 'token', onBehalfOf: p, delegation: 'intersect' });
      const rs: DecisionReadSet = {
        env: { ok: false, at: new Date('2026-01-01T00:00:00Z') },
        attributes: [
          { ref: doc, path: 'b', value: 2 },
          { ref: 'principal', path: 'a', value: 1 },
        ],
        relations: [
          { model: 'm', object: { type: 'p', id: '2' }, relation: 'r' },
          { model: 'm', object: doc, relation: 'owner' },
        ],
        modelVersions: { m: 'v3' },
      };
      // Computed by the inputsHash of v4-l-05b (2de6c01a2), before it was split.
      expect(inputsHash({ ...req, principal: p, actor: bot }, { ...decision, principal: p }, rs, 'p'.repeat(64))).to.equal('6acb0ba828e9efe6f90a8dbd913fbc5fbbc111e7b0ee8d069a210d12cc17e14a');
    });

    it('splits inputsHash into parts without changing it, whatever the principal and the reads', () => {
      const text = fc.string({ maxLength: 6 });
      const principalArb = fc.record({ type: fc.constantFrom('user', 'agent', 'a:b'), id: text, authenticated: fc.boolean(), source: text, attributes: fc.dictionary(text, fc.jsonValue({ maxDepth: 2 })), ceiling: fc.option(fc.record({ permissions: fc.array(text, { maxLength: 3 }) }), { nil: undefined }) });
      const refArb = fc.oneof(fc.constant<'principal'>('principal'), fc.record({ type: fc.constantFrom('doc', 'a%b'), id: text }));
      const readsArb = fc.record({
        env: fc.dictionary(text, fc.jsonValue({ maxDepth: 2 })),
        attributes: fc.array(fc.record({ ref: refArb, path: text, value: fc.jsonValue({ maxDepth: 2 }) }), { maxLength: 4 }),
        relations: fc.array(fc.record({ model: text, object: fc.record({ type: text, id: text }), relation: text }), { maxLength: 4 }),
        modelVersions: fc.dictionary(text, text),
      });
      fc.assert(
        fc.property(principalArb, fc.option(principalArb, { nil: undefined }), readsArb, text, (p, actor, rs, policyHash) => {
          const r: DecisionRequest = { ...req, principal: p, ...(actor ? { actor } : {}) };
          return inputsHashOf(inputsHashParts(r, decision, rs, policyHash)) === inputsHash(r, decision, rs, policyHash);
        }),
      );
    });

    it('stores facts on every record, without attributes', async () => {
      const p = principal('user', '7', { attributes: { email: 'a@b' }, ceiling: { permissions: ['doc:read'] } });
      const { tap, sink } = tapOf();
      tap.onDecision({ ...req, principal: p }, decision, reads, { cached: false, durationMs: 1 });
      const r = await recorded(tap, sink);
      expect(r.facts).to.deep.equal({ principal: { type: 'user', id: '7', ceiling: { permissions: ['doc:read'] } } });
      expect(r.inputs).to.equal(undefined);
    });

    it("stores the actor's facts next to the principal's, and none when either has none", async () => {
      const agent = principal('agent', 'bot', { onBehalfOf: alice, delegation: 'intersect' });
      const { tap, sink } = tapOf();
      tap.onDecision({ ...req, actor: agent }, { ...decision, actor: agent }, reads, { cached: false, durationMs: 1 });
      tap.onDecision({ ...req, actor: principal('agent', 'x', { attributes: {}, ceiling: { roles: ['r'.repeat(5000)] } }) }, decision, reads, { cached: false, durationMs: 1 });
      await tap.flush();
      const [withActor, oversized] = sink.records;
      expect(withActor.facts).to.deep.equal({ principal: { type: 'user', id: 'alice' }, actor: { type: 'agent', id: 'bot', onBehalfOf: { type: 'user', id: 'alice' }, delegation: 'intersect' } });
      expect(oversized).to.not.have.property('facts');
    });

    it("records the wall clock and the duration next to the caller's env.now", async () => {
      const asOf = new Date('2020-01-01T00:00:00Z');
      const { tap, sink } = tapOf();
      tap.onDecision({ ...req, env: { now: asOf } }, decision, reads, { cached: false, durationMs: 12 });
      const r = await recorded(tap, sink);
      expect(r.at).to.equal(asOf.toISOString());
      expect(Date.parse(r.loggedAt!)).to.be.closeTo(Date.now(), 5_000);
      expect(r.durationMs).to.equal(12);
    });

    describe('trace ids without a DecisionTraceContext', () => {
      const TRACE = '0af7651916cd43dd8448eb211c80319c';
      let spans: InMemorySpans;

      beforeEach(() => {
        spans = useInMemorySpans();
      });

      afterEach(async () => spans.detach());

      const inStore = <T>(traceId: unknown, fn: () => Promise<T>): Promise<T> => authzStorage().run({ traceId }, fn);

      it('takes the trace id of the request store, the one changelog rows get', async () => {
        const { a, tap, sink } = tapOf();
        await inStore(TRACE, () => a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } }));
        const r = await recorded(tap, sink);
        expect(r.traceId).to.equal(TRACE);
        expect(r).to.not.have.property('spanId');
      });

      it('ignores a store value that is not 32 hex characters', async () => {
        const { a, tap, sink } = tapOf();
        for (const bad of ['xyz', TRACE.toUpperCase(), 42]) await inStore(bad, () => a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } }));
        await tap.flush();
        expect(sink.records.map((r) => r.traceId)).to.deep.equal(spans.byName('authz.check').map((s) => s.spanContext().traceId));
      });

      it('takes the span id of the active authz.check span when it is in the same trace', async () => {
        const { a, tap, sink } = tapOf();
        await withSpan('request', {}, () => inStore(activeTraceIds()!.traceId, () => a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } })));
        await inStore(TRACE, () => a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } }));
        await tap.flush();
        const [check, other] = spans.byName('authz.check').map((s) => s.spanContext());
        expect(sink.records.map((r) => [r.traceId, r.spanId])).to.deep.equal([
          [check.traceId, check.spanId],
          [TRACE, undefined],
        ]);
        expect(other.traceId).to.not.equal(TRACE);
      });

      it('takes both ids from the active span outside a request (a queue handler, a scheduler run)', async () => {
        const { a, tap, sink } = tapOf();
        await a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } });
        const r = await recorded(tap, sink);
        const [check] = spans.byName('authz.check').map((s) => s.spanContext());
        expect([r.traceId, r.spanId]).to.deep.equal([check.traceId, check.spanId]);
      });

      it('lets a registered DecisionTraceContext win', async () => {
        class Trace extends DecisionTraceContext {
          current() {
            return { traceId: 't'.repeat(32), spanId: 's'.repeat(16) };
          }
          annotate() {}
        }
        const { a, tap, sink } = tapOf({ trace: new Trace() });
        await inStore(TRACE, () => a.check({ principal: alice, permission: 'doc:read', resource: doc, env: { ok: false } }));
        const r = await recorded(tap, sink);
        expect([r.traceId, r.spanId]).to.deep.equal(['t'.repeat(32), 's'.repeat(16)]);
      });
    });
  });
});
