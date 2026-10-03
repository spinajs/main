import 'mocha';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { Job, QueueJob } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';

import { AuthzQueueHook, InitiatorPrincipalFactory, StampedInitiatorPrincipalFactory, reviveCeiling } from '../src/index.js';

const user = (id: string, extra: Partial<Principal> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {}, ...extra });

/** The hook over a stand-in AuthzService: `current()` and `runAs()` are all it calls. */
class TestHook extends AuthzQueueHook {
  ambient: Principal = UNATTENDED;
  ranAs: { principal: Principal; reason: string }[] = [];

  protected async service(): Promise<AuthzService> {
    const self = this;
    return {
      current: () => self.ambient,
      runAs: async (principal: Principal, reason: string, fn: () => Promise<unknown>) => {
        self.ranAs.push({ principal, reason });
        return fn();
      },
    } as unknown as AuthzService;
  }
}

@Job({ runAs: 'initiator' })
class AsInitiator extends QueueJob {
  async execute() {
    return 1;
  }
}
@Job({ runAs: 'system' })
class AsSystem extends QueueJob {
  async execute() {
    return 1;
  }
}
@Job({ runAs: 'root' as never })
class AsTypo extends QueueJob {
  async execute() {
    return 1;
  }
}
@Job()
class AsNone extends QueueJob {
  async execute() {
    return 1;
  }
}

const messageOf = (cls: new () => QueueJob, initiator?: unknown): IQueueMessage => {
  const m = new cls();
  if (initiator !== undefined) (m as { Initiator?: unknown }).Initiator = initiator;
  return m;
};

const run = async (hook: TestHook, m: IQueueMessage) => {
  await hook.aroundHandle(m, async () => 'done');
  return hook.ranAs[hook.ranAs.length - 1];
};

describe('AuthzQueueHook.beforeEmit', () => {
  it('stamps the ambient principal', async () => {
    const hook = new TestHook();
    hook.ambient = user('alice');
    const m = { Name: 'x' } as IQueueMessage;

    await hook.beforeEmit(m);

    expect(m.Initiator).to.deep.equal({ type: 'user', id: 'alice' });
  });

  it('stamps nothing for UNATTENDED and drops an Initiator the caller set', async () => {
    const hook = new TestHook();
    const m = { Name: 'x', Initiator: { type: 'system', id: 'system' } } as IQueueMessage;

    await hook.beforeEmit(m);

    expect(m).to.not.have.property('Initiator');
  });

  it('replaces an Initiator the caller set with the ambient principal', async () => {
    const hook = new TestHook();
    hook.ambient = user('alice');
    const m = { Name: 'x', Initiator: { type: 'system', id: 'system' } } as IQueueMessage;

    await hook.beforeEmit(m);

    expect(m.Initiator).to.deep.equal({ type: 'user', id: 'alice' });
  });

  it('does not stamp a system-typed principal that is not the SYSTEM singleton', async () => {
    const hook = new TestHook();
    hook.ambient = { ...SYSTEM };
    const m = { Name: 'x' } as IQueueMessage;

    await hook.beforeEmit(m);

    expect(m).to.not.have.property('Initiator');
  });

  it('stamps SYSTEM', async () => {
    const hook = new TestHook();
    hook.ambient = SYSTEM;
    const m = { Name: 'x' } as IQueueMessage;

    await hook.beforeEmit(m);

    expect(m.Initiator).to.deep.equal({ type: 'system', id: 'system' });
  });
});

describe('AuthzQueueHook.aroundHandle', () => {
  it('without runAs the handler runs unattended', async () => {
    const hook = new TestHook();
    const ran = await run(hook, messageOf(AsNone, { type: 'user', id: 'alice' }));
    expect(ran.principal).to.equal(UNATTENDED);
    expect(ran.reason).to.equal('job:AsNone');
  });

  it('an unknown runAs value runs unattended', async () => {
    const hook = new TestHook();
    const ran = await run(hook, messageOf(AsTypo, { type: 'system', id: 'system' }));
    expect(ran.principal).to.equal(UNATTENDED);
  });

  it("runAs 'system' ignores the Initiator", async () => {
    const hook = new TestHook();
    const ran = await run(hook, messageOf(AsSystem, { type: 'user', id: 'alice' }));
    expect(ran.principal).to.equal(SYSTEM);
  });

  it("runAs 'initiator' without an Initiator runs unattended, not as system", async () => {
    const hook = new TestHook();
    const ran = await run(hook, messageOf(AsInitiator));
    expect(ran.principal).to.equal(UNATTENDED);
  });

  it("runAs 'initiator' rebuilds the principal and revives the ceiling's date after JSON", async () => {
    const hook = new TestHook();
    const expiresAt = new Date('2031-01-02T03:04:05.000Z');
    const wire = JSON.parse(JSON.stringify({ type: 'user', id: 'alice', ceiling: { permissions: ['file:read'], expiresAt } }));

    const ran = await run(hook, messageOf(AsInitiator, wire));

    expect(ran.principal).to.include({ type: 'user', id: 'alice', source: 'queue', authenticated: true });
    expect(ran.principal.ceiling?.permissions).to.deep.equal(['file:read']);
    expect(ran.principal.ceiling?.expiresAt).to.be.instanceOf(Date);
    expect(ran.principal.ceiling?.expiresAt?.getTime()).to.equal(expiresAt.getTime());
  });

  it("runAs 'initiator' of an initiator the stamp says is unattended runs unattended", async () => {
    const hook = new TestHook();
    const ran = await run(hook, messageOf(AsInitiator, { type: 'unattended', id: 'unattended' }));
    expect(ran.principal).to.equal(UNATTENDED);
  });

  it('a malformed Initiator runs unattended', async () => {
    const hook = new TestHook();
    for (const bad of ['alice', 7, { type: 'user' }, { id: 'a' }, { type: '', id: 'a' }, { type: 'user', id: 'a', ceiling: 'x' }, { type: 'user', id: 'a', ceiling: { roles: 'admin' } }, { type: 'user', id: 'a', ceiling: { expiresAt: 'soon' } }]) {
      const ran = await run(hook, messageOf(AsInitiator, bad));
      expect(ran.principal, JSON.stringify(bad)).to.equal(UNATTENDED);
    }
  });

  it('returns what the handler returns and passes its error through', async () => {
    const hook = new TestHook();
    expect(await hook.aroundHandle(messageOf(AsNone), async () => 42)).to.equal(42);
    await hook.aroundHandle(messageOf(AsNone), async () => Promise.reject(new Error('boom'))).then(
      () => expect.fail('should reject'),
      (e) => expect(e.message).to.equal('boom'),
    );
  });

  it('uses the registered InitiatorPrincipalFactory', async () => {
    class Reloading extends InitiatorPrincipalFactory {
      async principalOf(initiator: { id: string }) {
        return user(initiator.id, { attributes: { dept: 'support' } });
      }
    }
    DI.register(Reloading).as(InitiatorPrincipalFactory);
    DI.uncache(InitiatorPrincipalFactory);
    try {
      const hook = new TestHook();
      const ran = await run(hook, messageOf(AsInitiator, { type: 'user', id: 'alice' }));
      expect(ran.principal.attributes).to.deep.equal({ dept: 'support' });
    } finally {
      DI.unregister(Reloading);
      DI.uncache(InitiatorPrincipalFactory);
      DI.uncache(Reloading);
    }
  });
});

describe('reviveCeiling', () => {
  it('copies the known fields and nothing else', () => {
    const c = reviveCeiling({ roles: ['a'], permissions: ['p:*'], resources: [{ type: 'file', id: 'f1' }, { type: 'dir' }], reason: 'r', extra: 1 });
    expect(c).to.deep.equal({ roles: ['a'], permissions: ['p:*'], resources: [{ type: 'file', id: 'f1' }, { type: 'dir' }], reason: 'r' });
  });

  it('refuses a wrong shape', () => {
    for (const bad of [null, [], 'x', { resources: [null] }, { resources: [{ type: 1 }] }, { resources: [{ type: 'a', id: 2 }] }, { reason: 1 }]) {
      expect(reviveCeiling(bad), JSON.stringify(bad)).to.equal(undefined);
    }
  });
});

describe('StampedInitiatorPrincipalFactory', () => {
  it('marks anonymous as not authenticated', async () => {
    const p = await new StampedInitiatorPrincipalFactory().principalOf({ type: 'anonymous', id: 'a1' });
    expect(p.authenticated).to.equal(false);
  });
});

describe('AuthzQueueHook.beforeEmit, principals the stamp cannot carry', () => {
  const stamped = async (p: Principal) => {
    const hook = new TestHook();
    hook.ambient = p;
    const m = { Name: 'x' } as IQueueMessage;
    await hook.beforeEmit(m);
    return m.Initiator;
  };

  it('stamps nothing for a delegated principal', async () => {
    expect(await stamped(user('agent', { onBehalfOf: user('alice') }))).to.equal(undefined);
    expect(await stamped(user('agent', { delegation: 'inherit' }))).to.equal(undefined);
  });

  it('stamps nothing for an impersonating principal', async () => {
    expect(await stamped(user('alice', { authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), impersonator: { type: 'user', id: 'admin' } } }))).to.equal(undefined);
  });

  it('stamps a malformed ceiling as deny-all', async () => {
    for (const bad of [['x'], 'x', new (class C { permissions = ['a']; })(), { permissions: 'a' }, { expiresAt: 'soon' }]) {
      const s = await stamped(user('alice', { ceiling: bad as never }));
      expect(s?.ceiling, JSON.stringify(bad)).to.deep.equal({ permissions: [] });
    }
  });

  it('treats null ceiling fields as absent', () => {
    expect(reviveCeiling({ roles: null, permissions: ['a'] })).to.deep.equal({ permissions: ['a'] });
  });
});
