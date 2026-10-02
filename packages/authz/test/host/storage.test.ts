import * as chai from 'chai';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';

import { authzStorage, currentPrincipal, requestScope, runWithPrincipal, UNATTENDED } from '@spinajs/authz';
import type { IAuthzAsyncStorage, Principal } from '@spinajs/authz';

const expect = chai.expect;

const alice = { type: 'user', id: 'alice' } as unknown as Principal;
const bob = { type: 'user', id: 'bob' } as unknown as Principal;

describe('host ALS storage', () => {
  let preexisting = false;
  before(() => {
    preexisting = DI.has(AsyncLocalStorage);
  });
  after(() => {
    if (!preexisting) DI.uncache(AsyncLocalStorage);
  });

  describe('outside any store', () => {
    it('currentPrincipal is UNATTENDED', () => {
      expect(currentPrincipal()).to.equal(UNATTENDED);
    });

    it('requestScope gives a fresh map per call', () => {
      const a = requestScope();
      const b = requestScope();
      expect(a.cache).to.be.instanceOf(Map);
      expect(a.cache).to.not.equal(b.cache);
    });
  });

  describe('inside a store', () => {
    it('currentPrincipal is the stored principal', () => {
      authzStorage().run({ Principal: alice }, () => {
        expect(currentPrincipal()).to.equal(alice);
      });
    });

    it('a non-object Principal gives UNATTENDED', () => {
      for (const bad of ['alice', 42, null, undefined, true]) {
        authzStorage().run({ Principal: bad } as unknown as IAuthzAsyncStorage & Record<string, unknown>, () => {
          expect(currentPrincipal()).to.equal(UNATTENDED);
        });
      }
    });

    it('requestScope creates AuthzCache once and reuses it', () => {
      const store: IAuthzAsyncStorage & Record<string, unknown> = {};
      authzStorage().run(store, () => {
        const a = requestScope();
        const b = requestScope();
        expect(a.cache).to.be.instanceOf(Map);
        expect(a.cache).to.equal(b.cache);
        expect(store.AuthzCache).to.equal(a.cache);
      });
    });

    it('requestScope replaces a non-Map AuthzCache', () => {
      const store = { AuthzCache: {} } as unknown as IAuthzAsyncStorage & Record<string, unknown>;
      authzStorage().run(store, () => {
        expect(requestScope().cache).to.be.instanceOf(Map);
        expect(store.AuthzCache).to.be.instanceOf(Map);
      });
    });
  });

  describe('runWithPrincipal', () => {
    it('makes the principal current only inside fn', async () => {
      const seen = await runWithPrincipal(bob, async () => currentPrincipal());
      expect(seen).to.equal(bob);
      expect(currentPrincipal()).to.equal(UNATTENDED);
    });

    it('keeps other keys, gives a fresh cache and leaves the caller store alone', async () => {
      const outerCache = new Map<string, unknown>();
      const store: IAuthzAsyncStorage & Record<string, unknown> = { Principal: alice, AuthzCache: outerCache, requestId: 'r1' };
      await authzStorage().run(store, async () => {
        const inner = await runWithPrincipal(bob, async () => {
          const s = authzStorage().getStore()!;
          return { requestId: s.requestId, principal: currentPrincipal(), cache: requestScope().cache };
        });
        expect(inner.requestId).to.equal('r1');
        expect(inner.principal).to.equal(bob);
        expect(inner.cache).to.be.instanceOf(Map);
        expect(inner.cache).to.not.equal(outerCache);
        expect(currentPrincipal()).to.equal(alice);
        expect(requestScope().cache).to.equal(outerCache);
      });
      expect(store.Principal).to.equal(alice);
      expect(store.AuthzCache).to.equal(outerCache);
    });

    it('drops AuthzDecision and Unscoped inside fn and keeps them outside', async () => {
      const store = { AuthzDecision: { allowed: true }, Unscoped: 'why', requestId: 'r' } as unknown as IAuthzAsyncStorage & Record<string, unknown>;
      await authzStorage().run(store, async () => {
        const inner = await runWithPrincipal(bob, async () => ({ ...authzStorage().getStore()! }));
        expect(inner).to.not.have.property('AuthzDecision');
        expect(inner).to.not.have.property('Unscoped');
        expect(inner.requestId).to.equal('r');
        expect(authzStorage().getStore()!.Unscoped).to.equal('why');
      });
      expect(store.AuthzDecision).to.not.equal(undefined);
      expect(store.Unscoped).to.equal('why');
    });

    it('turns a synchronous throw of fn into a rejection', async () => {
      let err: unknown;
      try {
        await runWithPrincipal(alice, (() => {
          throw new Error('sync');
        }) as () => Promise<never>);
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).to.equal('sync');
    });

    it('returns the result and propagates a rejection', async () => {
      expect(await runWithPrincipal(alice, async () => 7)).to.equal(7);
      let err: unknown;
      try {
        await runWithPrincipal(alice, async () => {
          throw new Error('boom');
        });
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).to.equal('boom');
    });
  });

  it('uses the DI-resolved AsyncLocalStorage', () => {
    expect(authzStorage()).to.equal(DI.resolve(AsyncLocalStorage));
    DI.resolve(AsyncLocalStorage).run({ Principal: bob } as Record<string, unknown>, () => {
      expect(currentPrincipal()).to.equal(bob);
    });
  });
});
