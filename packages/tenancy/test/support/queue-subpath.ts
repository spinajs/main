// A consumer process as the docs set it up: it imports @spinajs/tenancy/queue and nothing else of the package.
import { DI } from '@spinajs/di';
import { Job, QueueHeaders, QueueJob, QueueMessageHook, SystemTask } from '@spinajs/queue';
import '@spinajs/tenancy/queue';
import { createTestApp } from '@spinajs/testing';

@SystemTask('probes the tenant hook; no principal is involved')
@Job()
class SubpathProbe extends QueueJob {
  public execute() {
    return Promise.resolve(null);
  }
}

await createTestApp({
  bootstrap: false,
  config: {
    logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
    tenancy: { tenants: [{ id: 'acme' }] },
  },
});
const message = new SubpathProbe();
message.Headers = { [QueueHeaders.Tenant]: 'acme' };
const handler = async (): Promise<string> => {
  // Loaded only here, after the hook admitted the tenant, so it cannot register the registry the hook needs.
  const { requireTenant } = await import('@spinajs/tenancy');
  return requireTenant().id;
};
const hooks = DI.resolve(Array.ofType(QueueMessageHook)).sort((a, b) => a.order - b.order);
const handle = hooks.reduceRight<() => Promise<string>>((next, hook) => () => hook.aroundHandle(message, next), handler);

try {
  console.log(JSON.stringify({ hooks: hooks.map((hook) => hook.constructor.name), tenant: await handle(), error: null }));
} catch (error) {
  console.log(JSON.stringify({ hooks: hooks.map((hook) => hook.constructor.name), tenant: null, error: error instanceof Error ? error.message : String(error) }));
}
process.exit(0);
