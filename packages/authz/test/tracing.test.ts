import 'mocha';
import * as chai from 'chai';
import { SpanStatusCode } from '@opentelemetry/api';
import { useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { Authorizer } from '../src/engine/authorizer.js';
import { LruDecisionCache } from '../src/engine/cache.js';
import { TRUE, resourceKey } from '../src/index.js';
import { RecordingAudit, RecordingLog, StaticModel, fakeClock, permit, principal, registryOf } from './engine/fakes.js';
import type { VoteSpec } from './engine/fakes.js';

const expect = chai.expect;

const REG = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice');
const input = { principal: alice, permission: 'doc:read' };

describe('Authorizer spans', () => {
  let clock: ReturnType<typeof fakeClock>;
  let spans: InMemorySpans;

  const make = (vote: VoteSpec): Authorizer =>
    new Authorizer({ domain: 'root', models: [new StaticModel('m', { vote })], registry: REG, clock: clock.clock, log: new RecordingLog(), audit: new RecordingAudit(), cache: new LruDecisionCache({ clock: clock.clock }) });

  beforeEach(() => {
    clock = fakeClock();
    spans = useInMemorySpans();
  });

  afterEach(() => spans.detach());

  it('records an allowed check with its request and outcome', async () => {
    const decision = await make(permit(TRUE, { cacheable: true })).check(input, { cache: new Map() });

    const [span] = spans.byName('authz.check');
    expect(span.attributes).to.deep.include({
      'spina.authz.domain': 'root',
      'spina.authz.permission': 'doc:read',
      'spina.authz.resource': resourceKey(decision.resource),
      'spina.principal.id': 'user:alice',
      'spina.authz.allowed': true,
      'spina.authz.cached': false,
    });
    expect(span.attributes).to.not.have.property('spina.authz.reason');
    expect(span.status.code).to.equal(SpanStatusCode.UNSET);
  });

  it('marks a decision served from the request cache', async () => {
    const a = make(permit(TRUE, { cacheable: true }));
    const scope = { cache: new Map<string, unknown>() };
    await a.check(input, scope);
    spans.reset();
    await a.check(input, scope);

    expect(spans.byName('authz.check')[0].attributes['spina.authz.cached']).to.equal(true);
  });

  it('records a deny with its reason and leaves the status unset: a deny is not a failed check', async () => {
    const decision = await make({ reason: { code: 'no_access' } }).check(input, { cache: new Map() });
    expect(decision.allowed).to.equal(false);

    const [span] = spans.byName('authz.check');
    expect(span.attributes['spina.authz.allowed']).to.equal(false);
    expect(span.attributes['spina.authz.reason']).to.be.a('string').and.equal(decision.reason?.code);
    expect(span.status.code).to.equal(SpanStatusCode.UNSET);
  });

  it('sets ERROR when the check throws', async () => {
    let thrown: unknown;
    try {
      await make({}).check({ principal: alice, permission: 'doc:unknown' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).to.be.instanceOf(Error);

    const [span] = spans.byName('authz.check');
    expect(span.status.code).to.equal(SpanStatusCode.ERROR);
    expect(span.events.map((e) => e.name)).to.deep.equal(['exception']);
  });

  it('nests the check under an explain span', async () => {
    await make(permit(TRUE, { cacheable: true })).explain(input);

    const [root] = spans.tree();
    expect(root.span.name).to.equal('authz.explain');
    expect(root.span.attributes['spina.authz.domain']).to.equal('root');
    expect(root.children.map((n) => n.span.name)).to.deep.equal(['authz.check']);
  });
});
