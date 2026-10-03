import 'mocha';
import { StaticModel, hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';

import { AdminGuard, AuthorizationModel, AuthzContributor, AuthzEventSink, MemoryScopeAttributeStore, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzEvent, AuthzService } from '@spinajs/authz';

class PermissiveScopeGuard extends AdminGuard {
  async check(): Promise<void> {}
}

class RecordingEvents extends AuthzEventSink {
  readonly events: AuthzEvent[] = [];

  async publish(events: readonly AuthzEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

runBehaviour(
  ['B39.store', 'B43.attributes'],
  () => {
    const sinks = new WeakMap<object, RecordingEvents>();
    return hostHarness({
      facets: ['admin', 'scopeAttributes'],
      kitScopeAttributes: false,
      register(host) {
        const c = host.container;
        const store = new MemoryScopeAttributeStore({ values: host.world.scopeAttributes?.values ?? [] });
        c.register(testHost.instance(store)).as(ScopeAttributeStore);
        c.register(testHost.instance(store)).as(WritableScopeAttributeStore);
        const schemas = host.world.scopeAttributes?.schemas ?? [];
        c.register(testHost.instance({ contribute: () => ({ scopeAttributeSchemas: schemas }) })).as(AuthzContributor);
        // B43.attributes routes to a model named rbac; this lane has none, and SYSTEM runs its commands.
        if (host.world.rbac) c.register(testHost.instance(new StaticModel({ name: 'rbac', votes: () => ({}) }))).as(AuthorizationModel);
        c.register(PermissiveScopeGuard).as(AdminGuard);
        const sink = new RecordingEvents();
        sinks.set(c, sink);
        c.register(testHost.instance(sink)).as(AuthzEventSink);
        host.setConfig(['authz', 'admin', 'guard', 'service'], 'PermissiveScopeGuard');
        // B39.store declares authz:scope.manage without types, so it only applies to type 'authz', yet the
        // command is checked at the scope (lane design §3.2). Give it the world's scope types (report hand-off).
        if (host.world.permissions.includes('authz:scope.manage')) {
          const types = [...new Set((host.world.scopes ?? []).flatMap((s) => (s.nodes ?? []).map((n) => n.ref.type)))];
          host.setConfig(['authz', 'domains', host.domain, 'permissions', 'authz:scope.manage'], { types });
        }
      },
      extend: (host, session) => ({
        admin: (session.authz as unknown as AuthzService).admin(),
        lane: { adminEvents: sinks.get(host.container)! },
      }),
    });
  },
  { strict: true },
);
