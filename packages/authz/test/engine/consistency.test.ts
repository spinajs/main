import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { LruDecisionCache } from '../../src/engine/cache.js';
import { AuthzConfigError, FALSE, TRUE, consistencyToken, tokenGeneration } from '../../src/index.js';
import type { DecisionRequest } from '../../src/index.js';
import { StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice');
const doc = { type: 'doc', id: 'd1' };

function setup() {
  const seen: DecisionRequest[] = [];
  const clock = fakeClock();
  const model = new StaticModel('m', {
    vote: (req: DecisionRequest) => {
      seen.push(req);
      return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
    },
  });
  const a = new Authorizer({ domain: 'root', registry, models: [model], cache: new LruDecisionCache({ clock: clock.clock }), clock: clock.clock });
  // A fresh request scope per check, so only the L2 can serve a repeat.
  const check = (atLeast?: string) => a.check({ principal: alice, permission: 'doc:read', resource: doc, ...(atLeast === undefined ? {} : { consistency: { atLeast } }) }, { cache: new Map() });
  return { check, seen };
}

describe('consistency tokens', () => {
  it('name a generation and refuse anything else', () => {
    expect(tokenGeneration(consistencyToken(42))).to.equal(42);
    expect(consistencyToken(42)).to.match(/^[A-Za-z0-9_-]+$/);
    for (const foreign of ['', 'abc', Buffer.from('spina:g:-1').toString('base64url'), Buffer.from('spina:g:01').toString('base64url'), Buffer.from('other:7').toString('base64url')]) expect(tokenGeneration(foreign), foreign).to.equal(undefined);
  });

  it('a token newer than the engine has seen skips what the caches hold; from then on the caches key on its generation', async () => {
    const { check, seen } = setup();
    await check();
    await check();
    expect(seen).to.have.length(1);
    await check(consistencyToken(5));
    expect(seen).to.have.length(2);
    // Without a token, or with an older one, the check finds what the token check stored.
    await check();
    await check(consistencyToken(3));
    await check(consistencyToken(5));
    expect(seen).to.have.length(2);
    await check(consistencyToken(6));
    expect(seen).to.have.length(3);
  });

  it('the models get the token; an unreadable token checks fresh; a malformed option is a config error', async () => {
    const { check, seen } = setup();
    await check(consistencyToken(2));
    expect(seen[0].consistency).to.deep.equal({ atLeast: consistencyToken(2) });
    await check('not-a-token');
    await check('not-a-token');
    expect(seen).to.have.length(3);
    expect(seen[2].fresh).to.equal(true);
    const a = new Authorizer({ domain: 'root', registry, models: [], clock: fakeClock().clock });
    let error: unknown;
    try {
      await a.check({ principal: alice, permission: 'doc:read', consistency: 'x' as unknown as { atLeast: string } });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(AuthzConfigError);
  });
});
