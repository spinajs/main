import 'mocha';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, QueueMessage, SetupContext, World } from '@spinajs/authz-testing';
import type { AuthzService, Principal } from '@spinajs/authz';
import { QueueHeaders, QueueMessageHook } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';
import { runInTenant, tenantScope } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';
import { TenantQueueHook } from '@spinajs/tenancy/queue';

import { AuthzQueueHook } from '../src/index.js';
import { queueHarness } from './support/queue-harness.js';

// The import registers the tenant hook for every suite of this run; the chain test registers a traced subclass instead.
DI.unregister(TenantQueueHook);

const { combine, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');

const world: World = {
  permissions: [],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: () => ({}) })],
  lane: { queue: { jobs: [{ name: 'plain' }, { name: 'orderedAsInitiator', runAs: 'initiator' }] } },
};

const forged = (message: IQueueMessage): void => {
  message.Initiator = { type: 'user', id: 'mallory' };
};

class ForgingInitiatorHook extends QueueMessageHook {
  public override readonly order: number = 1;

  public beforeEmit(message: IQueueMessage): void {
    forged(message);
  }

  public aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    return next();
  }
}

class EarlyForgingInitiatorHook extends QueueMessageHook {
  public beforeEmit(message: IQueueMessage): void {
    forged(message);
  }

  public aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    return next();
  }
}

const trace: string[] = [];
const inApp: { tenant: TenantScope | undefined; principal: Principal['id'] }[] = [];
let authz: AuthzService | undefined;

class TracedTenantHook extends TenantQueueHook {
  public override beforeEmit(message: IQueueMessage): void {
    trace.push('tenant.beforeEmit');
    super.beforeEmit(message);
  }

  public override aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    trace.push('tenant.aroundHandle');
    return super.aroundHandle(message, next);
  }
}

class TracedAuthzHook extends AuthzQueueHook {
  public override async beforeEmit(message: IQueueMessage): Promise<void> {
    trace.push('authz.beforeEmit');
    await super.beforeEmit(message);
  }

  public override aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    trace.push('authz.aroundHandle');
    return super.aroundHandle(message, next);
  }
}

class AppHook extends QueueMessageHook {
  public beforeEmit(): void {
    trace.push('app.beforeEmit');
  }

  public aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    trace.push('app.aroundHandle');
    inApp.push({ tenant: tenantScope(), principal: authz!.current().id });
    return next();
  }
}

describe('AuthzQueueHook in the hook chain', () => {
  const harness = queueHarness();
  let session: HarnessSession;

  const emitAsAlice = (job: string): Promise<QueueMessage> => (session.authz as unknown as AuthzService).runAs(alice, 'test', () => session.lane!.queue!.emit(job));

  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());
  beforeEach(async () => {
    const context: SetupContext = { id: 'B30', part: 'queue', case: 'emit-order', title: 'emit-order', facets: ['engine', 'host', 'queue'] };
    session = await harness.setup(world, context);
    authz = session.authz as unknown as AuthzService;
  });
  afterEach(() => session.dispose());

  it('stamps the Initiator after a hook of a higher order wrote one', async () => {
    DI.register(ForgingInitiatorHook).as(QueueMessageHook);
    DI.uncache(Array.ofType(QueueMessageHook));

    try {
      expect((await emitAsAlice('plain')).Initiator).to.deep.include({ type: 'user', id: 'alice' });
    } finally {
      DI.unregister(ForgingInitiatorHook);
      DI.uncache(ForgingInitiatorHook);
      DI.uncache(Array.ofType(QueueMessageHook));
    }
  });

  it('stamps the Initiator after an order-0 hook registered before it', async () => {
    DI.unregister(AuthzQueueHook);
    DI.register(EarlyForgingInitiatorHook).as(QueueMessageHook);
    DI.register(AuthzQueueHook).as(QueueMessageHook);
    DI.uncache(Array.ofType(QueueMessageHook));

    try {
      expect((await emitAsAlice('plain')).Initiator).to.deep.include({ type: 'user', id: 'alice' });
    } finally {
      DI.unregister(EarlyForgingInitiatorHook);
      DI.uncache(EarlyForgingInitiatorHook);
      DI.uncache(Array.ofType(QueueMessageHook));
    }
  });

  it('nests the tenant hook, then itself, then the hooks of the default order', async () => {
    trace.length = 0;
    inApp.length = 0;
    // Registered innermost first: only `order` can put them in the chain's order.
    const chain: Class<QueueMessageHook>[] = [AppHook, TracedAuthzHook, TracedTenantHook];
    DI.unregister(AuthzQueueHook);
    for (const hook of chain) DI.register(hook).as(QueueMessageHook);
    DI.uncache(Array.ofType(QueueMessageHook));

    try {
      const message = await runInTenant('acme', () => emitAsAlice('orderedAsInitiator'));
      expect(message.Headers).to.deep.include({ [QueueHeaders.Tenant]: 'acme' });
      expect(message.Initiator).to.deep.include({ type: 'user', id: 'alice' });

      const run = await session.lane!.queue!.handle(message);
      expect(run.principal.id).to.eq('alice');
      expect(trace).to.deep.eq(['app.beforeEmit', 'authz.beforeEmit', 'tenant.beforeEmit', 'tenant.aroundHandle', 'authz.aroundHandle', 'app.aroundHandle']);
      expect(inApp).to.deep.eq([{ tenant: { kind: 'tenant', tenant: { id: 'acme' } }, principal: 'alice' }]);
    } finally {
      for (const hook of chain) {
        DI.unregister(hook);
        DI.uncache(hook);
      }
      DI.register(AuthzQueueHook).as(QueueMessageHook);
      DI.uncache(Array.ofType(QueueMessageHook));
    }
  });
});
