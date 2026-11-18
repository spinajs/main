import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SYSTEM, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import { Event, Job, QueueEvent, QueueHeaders, QueueJob, QueueMessageHook, QueueService, isPermanentJobFailure } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';
import { MemoryBroker, MemoryQueueClient } from '@spinajs/queue/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { MemoryTenantRegistry, TENANT_STATES, TenantRegistry, TenantUnavailable, currentTenant, runAcrossTenants, runInTenant, tenantRegistry, tenantScope } from '../src/index.js';
import type { TenantRecord, TenantScope } from '../src/index.js';
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

class FlakyTenantRegistry extends MemoryTenantRegistry {
  public down = false;

  public override get(id: string): Promise<TenantRecord | undefined> {
    return this.down ? Promise.reject(new Error('registry down')) : super.get(id);
  }
}

async function flakyRegistry(): Promise<FlakyTenantRegistry> {
  const inner = (await tenantRegistry()).inner;
  if (!(inner instanceof FlakyTenantRegistry)) throw new Error('expected the flaky registry');
  return inner;
}

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'ran',
    (err: unknown) => err,
  );

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
  const BROKER = 'tenancy-queue';
  let app: TestApp;

  // Each tenant but 'acme' is named after its state; 'acme' is active.
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
        tenancy: { registry: 'FlakyTenantRegistry' },
      },
      register: (container) => container.register(FlakyTenantRegistry).as(TenantRegistry),
    });
    const registry = await flakyRegistry();
    registry.add({ id: 'acme' });
    for (const state of TENANT_STATES) if (state !== 'active') registry.add({ id: state, state });
  });

  afterEach(async () => {
    await app?.dispose();
  });

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

  it('refuses for good a message for a tenant that is not active or not known, and never calls its handler', async () => {
    for (const tenant of ['provisioning', 'suspended', 'deleting', 'deleted', 'nobody']) {
      for (const message of [carrying(new CarryJob(), tenant), carrying(new RequiredJob(), tenant), carrying(new TenantPing(), tenant)]) {
        const refused = await failureOf(hook.aroundHandle(message, async () => 'ran'));

        if (!isPermanentJobFailure(refused)) throw new Error(`expected a permanent failure for ${tenant}, got ${String(refused)}`);
        expect(refused.reason).to.eq('tenant_unavailable');
        expect(refused.message).to.contain(`tenant "${tenant}"`);
        expect(refused.cause).to.be.instanceOf(TenantUnavailable);
      }
    }
  });

  it('runs a message for an active tenant in that tenant', async () => {
    expect(await scopeInside(carrying(new CarryJob(), 'acme'))).to.deep.eq(ACME);
    expect(await scopeInside(carrying(new RequiredJob(), 'acme'))).to.deep.eq(ACME);
  });

  it('refuses a message when the registry fails, logged apart from a refused state', async () => {
    const logged: { level: string; args: unknown[] }[] = [];
    const watched = new TenantQueueHook();
    const record =
      (level: string) =>
      (...args: unknown[]) =>
        void logged.push({ level, args });
    Object.defineProperty(watched, 'Log', { value: { warn: record('warn'), error: record('error') } });

    const suspended = await failureOf(watched.aroundHandle(carrying(new CarryJob(), 'suspended'), async () => 'ran'));
    (await flakyRegistry()).down = true;
    const failed = await failureOf(watched.aroundHandle(carrying(new CarryJob(), 'acme'), async () => 'ran'));

    expect(isPermanentJobFailure(suspended)).to.eq(true);
    expect(failed).to.be.instanceOf(Error).with.property('message', 'registry down');
    expect(isPermanentJobFailure(failed)).to.eq(false);
    expect(logged.map((l) => [l.level, l.args[1]])).to.deep.eq([
      ['warn', 'Message ${messageName} refused: tenant ${tenant} is not admitted (${reason})'],
      ['error', 'Message ${messageName} refused: the tenant registry failed to look up tenant ${tenant}'],
    ]);
  });

  it('asks the registry nothing for a message without a tenant, in the cross-tenant scope or under none', async () => {
    (await flakyRegistry()).down = true;

    expect(await scopeInside(new CarryJob())).to.eq(undefined);
    expect(await scopeInside(carrying(new CarryJob(), encodeTenantHeader(BILLING)))).to.deep.eq(BILLING);
    expect(await scopeInside(carrying(new DetachedJob(), 'suspended'))).to.eq(undefined);
  });

  describe('through the memory transport', function () {
    this.timeout(15000);

    let queue: QueueService;
    let client: MemoryQueueClient;

    beforeEach(async () => {
      queue = await app.resolve(QueueService);
      const connection = queue.get('memory');
      if (!(connection instanceof MemoryQueueClient)) throw new Error('expected the memory transport');
      client = connection;
    });

    afterEach(() => {
      MemoryBroker.drop(BROKER);
    });

    it('does not call the callback of an event for a suspended tenant: the delivery rejects', async () => {
      const seen: (string | undefined)[] = [];
      await queue.consume(TenantPing, async () => void seen.push(currentTenant()?.id));

      const refused = await failureOf(client.deliver(carrying(new TenantPing(), 'suspended')));
      await client.deliver(carrying(new TenantPing(), 'acme'));

      expect(isPermanentJobFailure(refused) && refused.reason).to.eq('tenant_unavailable');
      expect(seen).to.deep.eq(['acme']);
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
