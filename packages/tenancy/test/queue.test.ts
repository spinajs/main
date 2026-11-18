import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SYSTEM, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import { Event, Job, QueueEvent, QueueHeaders, QueueJob, QueueMessageHook, QueueService, isPermanentJobFailure } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';
import { MemoryBroker, MemoryQueueClient } from '@spinajs/queue/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { currentTenant, runAcrossTenants, runInTenant, tenantScope } from '../src/index.js';
import type { TenantScope } from '../src/index.js';
import { TENANT_QUEUE_HOOK_ORDER, TenantQueueHook, decodeTenantHeader, encodeTenantHeader } from '../src/queue.js';

@Job()
class CarryJob extends QueueJob {
  public async execute() {
    return null;
  }
}

@Job({ tenancy: 'required' })
class RequiredJob extends QueueJob {
  public async execute() {
    return null;
  }
}

@Job({ tenancy: 'none' })
class DetachedJob extends QueueJob {
  public async execute() {
    return null;
  }
}

@Event()
class TenantPing extends QueueEvent {}

const TENANT = QueueHeaders.Tenant;
const ACME: TenantScope = { kind: 'tenant', tenant: { id: 'acme' } };
const BILLING: TenantScope = { kind: 'all', reason: 'nightly billing; run 7\nżółć' };

const hook = new TenantQueueHook();

const carrying = (message: IQueueMessage, value: string): IQueueMessage => {
  message.Headers = { [TENANT]: value };
  return message;
};

const scopeInside = (message: IQueueMessage): Promise<TenantScope | undefined> => hook.aroundHandle(message, async () => tenantScope());

describe('the tenant header value', () => {
  it('is the tenant id, or * and the encoded reason, in printable ASCII', () => {
    expect(encodeTenantHeader(ACME)).to.eq('acme');
    expect(encodeTenantHeader(BILLING)).to.match(/^\*:[!-~]+$/);
    expect(decodeTenantHeader(encodeTenantHeader(ACME))).to.deep.eq(ACME);
    expect(decodeTenantHeader(encodeTenantHeader(BILLING))).to.deep.eq(BILLING);
  });

  it('reads a missing or malformed value as no scope', () => {
    for (const bad of [undefined, '', 'Acme Inc', '*', '*:', '*:%', '*:%20']) {
      expect(decodeTenantHeader(bad)).to.eq(undefined);
    }
  });
});

describe('TenantQueueHook', () => {
  it('runs ahead of hooks of the default order', () => {
    expect(hook.order).to.eq(TENANT_QUEUE_HOOK_ORDER);
    expect(TENANT_QUEUE_HOOK_ORDER).to.eq(-100);
  });

  it('stamps the ambient tenant, and the cross-tenant scope with its reason', async () => {
    const one: IQueueMessage = new CarryJob();
    const all: IQueueMessage = new CarryJob();

    await runInTenant('acme', async () => hook.beforeEmit(one));
    await runAcrossTenants(BILLING.kind === 'all' ? BILLING.reason : '', async () => hook.beforeEmit(all));

    expect(one.Headers).to.deep.eq({ [TENANT]: 'acme' });
    expect(decodeTenantHeader(all.Headers?.[TENANT])).to.deep.eq(BILLING);
  });

  it('drops a tenant header the caller wrote, and keeps the other headers', async () => {
    const forged = carrying(new CarryJob(), 'globex');
    const mixed: IQueueMessage = new CarryJob();
    mixed.Headers = { [TENANT]: 'globex', 'x-app': '1' };
    const replaced = carrying(new CarryJob(), 'globex');
    const cased: IQueueMessage = new CarryJob();
    cased.Headers = { 'X-SpinaJS-Tenant': 'globex', 'x-app': '1' };

    hook.beforeEmit(forged);
    hook.beforeEmit(mixed);
    await runInTenant('acme', async () => hook.beforeEmit(replaced));
    await runInTenant('acme', async () => hook.beforeEmit(cased));

    expect(forged.Headers).to.eq(undefined);
    expect(mixed.Headers).to.deep.eq({ 'x-app': '1' });
    expect(replaced.Headers).to.deep.eq({ [TENANT]: 'acme' });
    expect(cased.Headers).to.deep.eq({ 'x-app': '1', [TENANT]: 'acme' });
  });

  it('carry: runs the handler in the scope the message names', async () => {
    expect(await scopeInside(carrying(new CarryJob(), 'acme'))).to.deep.eq(ACME);
    expect(await scopeInside(carrying(new CarryJob(), encodeTenantHeader(BILLING)))).to.deep.eq(BILLING);
  });

  it('carry: a message without a tenant runs with no scope, also inside the scope of whoever delivers it', async () => {
    expect(await scopeInside(new CarryJob())).to.eq(undefined);
    expect(await runInTenant('globex', () => scopeInside(new CarryJob()))).to.eq(undefined);
    expect(await runInTenant('globex', () => scopeInside(carrying(new CarryJob(), 'acme')))).to.deep.eq(ACME);
  });

  it('carry: warns about a malformed header, with its start only, and runs the handler with no scope', async () => {
    const warnings: unknown[][] = [];
    const watched = new TenantQueueHook();
    Object.defineProperty(watched, 'Log', { value: { warn: (...args: unknown[]) => void warnings.push(args) } });
    const malformed = `Not An Id ${'x'.repeat(200)}`;

    expect(await watched.aroundHandle(carrying(new CarryJob(), malformed), async () => tenantScope())).to.eq(undefined);
    expect(await watched.aroundHandle(new CarryJob(), async () => tenantScope())).to.eq(undefined);

    expect(warnings).to.have.length(1);
    expect(warnings[0][0]).to.deep.eq({ messageName: 'CarryJob', header: malformed.slice(0, 64), length: malformed.length });
  });

  it('reads a tenant value that is not a string as malformed: a warning under carry, tenant_required under required', async () => {
    const warnings: unknown[][] = [];
    const watched = new TenantQueueHook();
    Object.defineProperty(watched, 'Log', { value: { warn: (...args: unknown[]) => void warnings.push(args) } });

    const carried = new CarryJob();
    carried.hydrate({ Headers: { [TENANT]: 42 } });
    const required = new RequiredJob();
    required.hydrate({ Headers: { [TENANT]: { id: 'acme' } } });

    expect(await watched.aroundHandle(carried, async () => tenantScope())).to.eq(undefined);
    const refused: unknown = await watched.aroundHandle(required, async () => 'ran').catch((err: unknown) => err);

    expect(warnings.map((w) => w[0])).to.deep.eq([{ messageName: 'CarryJob', type: 'number' }]);
    expect(isPermanentJobFailure(refused) && refused.reason).to.eq('tenant_required');
  });

  it('required: refuses for good a message that names no single tenant', async () => {
    for (const message of [new RequiredJob(), carrying(new RequiredJob(), encodeTenantHeader(BILLING)), carrying(new RequiredJob(), 'Not An Id')]) {
      const refused: unknown = await hook.aroundHandle(message, async () => 'ran').catch((err: unknown) => err);

      if (!isPermanentJobFailure(refused)) throw new Error(`expected a permanent failure, got ${String(refused)}`);
      expect(refused.reason).to.eq('tenant_required');
      expect(refused.message).to.match(/^tenant_required: RequiredJob needs a tenant/);
    }
    expect(await scopeInside(carrying(new RequiredJob(), 'acme'))).to.deep.eq(ACME);
  });

  it('none: runs the handler with no scope whatever the message and the consumer carry', async () => {
    expect(await runInTenant('globex', () => scopeInside(carrying(new DetachedJob(), 'acme')))).to.eq(undefined);
  });

  describe('through the memory transport', function () {
    this.timeout(15000);

    const BROKER = 'tenancy-queue';
    let app: TestApp;
    let queue: QueueService;
    let client: MemoryQueueClient;

    beforeEach(async () => {
      app = await createTestApp({
        bootstrap: false,
        config: {
          logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
          queue: {
            default: 'memory',
            routing: {},
            connections: [{ service: 'MemoryQueueClient', name: 'memory', defaultQueueChannel: '/queue/memory', defaultTopicChannel: '/topic/memory', defaultQueueDeadLetterChannel: '/queue/memory.dlq', options: { broker: BROKER, deferred: true } }],
          },
        },
      });
      queue = await app.resolve(QueueService);
      const connection = queue.get('memory');
      if (!(connection instanceof MemoryQueueClient)) throw new Error('expected the memory transport');
      client = connection;
    });

    afterEach(async () => {
      await app?.dispose();
      MemoryBroker.drop(BROKER);
    });

    it('handles a message in the tenant it was emitted in, also when it is delivered again', async () => {
      const seen: (string | undefined)[] = [];
      await queue.consume(TenantPing, async () => {
        seen.push(currentTenant()?.id);
        if (seen.length === 1) throw new Error('the first delivery fails');
      });

      await runInTenant('acme', () => TenantPing.emit({}));
      expect(client.published[0].Headers?.[TENANT]).to.eq('acme');

      await client.deliverAll();
      await client.deliverAll();

      expect(seen).to.deep.eq(['acme', 'acme']);
      expect(currentTenant()).to.eq(undefined);
    });

    it('carries the cross-tenant scope with its reason, and no scope for an emit outside every scope', async () => {
      const seen: (TenantScope | undefined)[] = [];
      await queue.consume(TenantPing, async () => void seen.push(tenantScope()));

      await runAcrossTenants('nightly billing', () => TenantPing.emit({}));
      await TenantPing.emit({});
      await client.deliverAll();

      expect(seen).to.deep.eq([{ kind: 'all', reason: 'nightly billing' }, undefined]);
    });

    it('runs a message delivered synchronously inside another tenant in the tenant the message names', async () => {
      const seen: (string | undefined)[] = [];
      await queue.consume(TenantPing, async () => void seen.push(currentTenant()?.id));

      await runInTenant('globex', async () => {
        await client.deliver(carrying(new TenantPing(), 'acme'));
        await client.deliver(new TenantPing());
      });

      expect(seen).to.deep.eq(['acme', undefined]);
    });

    it('keeps its stamp when hooks of a higher order write the tenant header', async () => {
      class ForgingHook extends QueueMessageHook {
        public beforeEmit(message: IQueueMessage): void {
          message.Headers = { ...message.Headers, [TENANT]: 'globex' };
        }

        public aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
          return next();
        }
      }
      class LateForgingHook extends ForgingHook {
        public override readonly order: number = 100;
      }
      DI.register(ForgingHook).as(QueueMessageHook);
      DI.register(LateForgingHook).as(QueueMessageHook);
      DI.uncache(Array.ofType(QueueMessageHook));

      try {
        await runInTenant('acme', () => TenantPing.emit({}));
      } finally {
        DI.unregister(ForgingHook);
        DI.unregister(LateForgingHook);
        DI.uncache(ForgingHook);
        DI.uncache(LateForgingHook);
        DI.uncache(Array.ofType(QueueMessageHook));
      }

      expect(client.published[0].Headers?.[TENANT]).to.eq('acme');
    });

    it('wraps a hook of the default order registered before it, so a principal switch inside keeps the tenant', async () => {
      const seen: { tenant?: string; principal: unknown }[] = [];
      class PrincipalHook extends QueueMessageHook {
        public beforeEmit(): void {}

        // What AuthzQueueHook does: its access check runs inside runWithPrincipal, before next().
        public async aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
          return runWithPrincipal(SYSTEM, async () => {
            seen.push({ tenant: currentTenant()?.id, principal: currentPrincipal() });
            return next();
          });
        }
      }
      DI.unregister(TenantQueueHook);
      DI.register(PrincipalHook).as(QueueMessageHook);
      DI.register(TenantQueueHook).as(QueueMessageHook);
      DI.uncache(Array.ofType(QueueMessageHook));

      try {
        await queue.consume(TenantPing, async () => void seen.push({ tenant: currentTenant()?.id, principal: currentPrincipal() }));
        await runInTenant('acme', () => TenantPing.emit({}));
        await client.deliverAll();
      } finally {
        DI.unregister(PrincipalHook);
        DI.uncache(Array.ofType(QueueMessageHook));
      }

      expect(seen).to.deep.eq([
        { tenant: 'acme', principal: SYSTEM },
        { tenant: 'acme', principal: SYSTEM },
      ]);
    });
  });
});
