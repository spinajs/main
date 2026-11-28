import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { ResourceAdapter, TRUE } from '@spinajs/authz';
import type { AuthzService, ResourceRef } from '@spinajs/authz';
import { activateIn, domains, installHost, instance, resetHost, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const doc1: ResourceRef = { type: 'doc', id: '1' };
const TIMED_OUT = 'ancestors of doc:1 timed out after 30 ms';

class HangingAncestors extends ResourceAdapter {
  readonly kind = 'hanging';
  readonly types = ['doc'];

  accepts(_t: unknown): _t is never {
    return false;
  }

  refOf(): never {
    throw new Error('unused');
  }

  ancestors(): Promise<null> {
    return new Promise<null>(() => undefined);
  }
}

/** What `p` settles with within 1 s: `{ value }` or `{ error }`, else `hung`. */
async function within<T>(p: Promise<T>): Promise<{ value: T } | { error: unknown } | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((resolve) => (timer = setTimeout(() => resolve('hung'), 1000)));
  try {
    return await Promise.race([p.then((value) => ({ value }), (error: unknown) => ({ error })), hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe('DefaultAuthzService: an ancestors() read that never settles', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    setConfig('authz.permissions', { 'doc:read': {} });
    setConfig(['authz', 'domains', 'stuck'], { engine: { modelTimeoutMs: 30 } });
  });

  const service = async (): Promise<AuthzService> => {
    const d = await domains();
    const c = d.create('stuck');
    c.register(instance(new HangingAncestors())).as(ResourceAdapter);
    activateIn(c, 'stuck', new StaticModel({ name: 'allow', votes: { '*': { permitWhen: TRUE } } }));
    return d.service('stuck');
  };

  it('makes check, can and assert throw the timeout after modelTimeoutMs, never allow @timing', async () => {
    const svc = await service();
    const calls: Promise<unknown>[] = [svc.check({ principal: alice, permission: 'doc:read', resource: doc1 }), svc.can(alice, 'doc:read', doc1), svc.assert(alice, 'doc:read', doc1)];
    for (const p of calls) {
      const out = await within(p);
      expect(out).to.have.property('error').that.is.instanceOf(Error).with.property('message', TIMED_OUT);
    }
  });

  it('makes checkAll settle with the entry not allowed @timing', async () => {
    const out = await within((await service()).checkAll(alice, [{ permission: 'doc:read', resource: doc1 }]));
    // Without per-entry fault isolation the batch rejects; with it, the entry alone is model_error.
    if (out !== 'hung' && 'value' in out) expect(out.value.map((d) => [d.allowed, d.reason?.code])).to.deep.equal([[false, 'model_error']]);
    else expect(out).to.have.property('error').that.is.instanceOf(Error).with.property('message', TIMED_OUT);
  });
});
