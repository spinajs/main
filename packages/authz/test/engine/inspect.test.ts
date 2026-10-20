import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { RequestScope } from '../../src/engine/authorizer.js';
import { LruDecisionCache } from '../../src/engine/cache.js';
import { AuthzConfigError } from '../../src/index.js';
import type { Decision } from '../../src/index.js';
import { FakeAdapter, FakeRow, RecordingAudit, StaticModel, deny, fakeClock, permit, principal, registryOf } from './fakes.js';

const expect = chai.expect;

class CountingCache extends LruDecisionCache {
  sets = 0;
  gets = 0;
  get(key: string): Decision | undefined {
    this.gets++;
    return super.get(key);
  }
  set(key: string, d: Decision, tags: readonly string[], ttlMs: number): void {
    this.sets++;
    super.set(key, d, tags, ttlMs);
  }
}

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const D1 = { type: 'doc', id: 'd1' };
const alice = principal('user', 'alice');
const scope = (): RequestScope => ({ cache: new Map<string, unknown>() });

const setup = (vote: Partial<import('../../src/index.js').Vote>) => {
  const clock = fakeClock();
  const audit = new RecordingAudit();
  const cache = new CountingCache({ clock: clock.clock });
  const model = new StaticModel('m', { vote });
  const a = new Authorizer({ domain: 'root', registry, models: [model], adapters: [new FakeAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] })], clock: clock.clock, audit, cache });
  return { a, audit, cache, model };
};

describe('inspect: an introspection check that is not an access attempt', () => {
  it('refuses a fresh or explain flag that is not a boolean instead of overwriting it', async () => {
    const { a } = setup(permit());
    for (const flag of ['fresh', 'explain']) {
      const e = await a.inspect({ principal: alice, permission: 'doc:read', resource: D1, [flag]: 'yes' } as never, scope()).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(e, flag).to.be.instanceOf(AuthzConfigError);
    }
  });

  it('records no audit entry for a denial, where check does', async () => {
    const { a, audit } = setup(deny());
    await a.check({ principal: alice, permission: 'doc:read', resource: D1 }, scope());
    expect(audit.kinds()).to.deep.equal(['deny']);
    audit.entries.length = 0;
    const d = await a.inspect({ principal: alice, permission: 'doc:read', resource: D1 }, scope());
    expect(d.allowed).to.equal(false);
    expect(audit.entries).to.have.length(0);
  });

  it('records no explain entry even when the input asks for a trace', async () => {
    const { a, audit } = setup(permit());
    await a.inspect({ principal: alice, permission: 'doc:read', resource: D1, explain: true }, scope());
    expect(audit.entries).to.have.length(0);
  });

  it('reads and stores nothing in the decision cache', async () => {
    const { a, cache } = setup(permit());
    await a.inspect({ principal: alice, permission: 'doc:read', resource: D1 }, scope());
    await a.inspect({ principal: alice, permission: 'doc:read', resource: D1 }, scope());
    expect(cache.sets).to.equal(0);
    expect(cache.gets).to.equal(0);
  });

  it('does not answer from a decision a check cached, and models receive fresh: true', async () => {
    const { a, model } = setup(permit());
    await a.check({ principal: alice, permission: 'doc:read', resource: D1 }, scope());
    expect(model.calls).to.have.length(1);
    await a.inspect({ principal: alice, permission: 'doc:read', resource: D1 }, scope());
    expect(model.calls).to.have.length(2);
    expect(model.calls[0].req.fresh).to.equal(undefined);
    expect(model.calls[1].req.fresh).to.equal(true);
  });
});
