import { AuthorizationModel, AuthzDomains, DecisionAudit, ResourceAdapter } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost } from '@spinajs/authz-testing';
import type { StaticModelOptions } from '@spinajs/authz-testing';

export interface TestDomain {
  readonly name: string;
  readonly model: StaticModel;
  readonly audit: RecordingAudit;
  readonly authz: AuthzService;
  dispose(): Promise<void>;
}

/**
 * A child domain of root holding one StaticModel `m1` and a RecordingAudit, booted. `permissions`
 * is `authz.domains.<name>.permissions`; `domain` merges into `authz.domains.<name>`.
 */
export async function createDomain(name: string, opts: { permissions: Record<string, unknown>; model?: StaticModelOptions; adapters?: readonly ResourceAdapter[]; domain?: Record<string, unknown> }): Promise<TestDomain> {
  const cfg = testHost.config();
  cfg.set(['authz', 'domains', name], { permissions: opts.permissions, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 }, ...(opts.domain ?? {}) });

  const domains = (await testHost.domains()) as AuthzDomains;
  const container = domains.create(name, 'root');
  const model = new StaticModel({ name: 'm1', ...(opts.model ?? {}) });
  const audit = new RecordingAudit();
  container.register(testHost.instance(model)).as(AuthorizationModel);
  container.register(testHost.instance(audit)).as(DecisionAudit);
  for (const a of opts.adapters ?? []) container.register(testHost.instance(a)).as(ResourceAdapter);

  try {
    const authz = await domains.service(name);
    return {
      name,
      model,
      audit,
      authz,
      async dispose() {
        await container.dispose();
        cfg.unset(['authz', 'domains', name]);
      },
    };
  } catch (e) {
    await container.dispose();
    cfg.unset(['authz', 'domains', name]);
    throw e;
  }
}
