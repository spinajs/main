import { AuthzAdminBackend, AuthzConfigError, ChangeBus, SYSTEM, forgetScopesInTx } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { ResolveType, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { domainContainer, recordAudit } from '../host.js';
import { afterCommit } from './commit.js';

const SYSTEM_REF = Object.freeze({ type: SYSTEM.type, id: SYSTEM.id });
export const RESOURCE_DELETED = 'resource-deleted';
const DELETED = Object.freeze({ actor: SYSTEM, reason: RESOURCE_DELETED });

// As DefaultAuthzAdmin.named (admin.ts:431-441): the class of that name registered for AuthzAdminBackend.
async function adminBackend(container: IContainer, name: string): Promise<AuthzAdminBackend> {
  const entry = container.Registry.getTypesChain(AuthzAdminBackend)
    .filter((e) => !isFactory(e.type) && (e.type as { name?: string }).name === name)
    .pop();
  if (!entry) throw new AuthzConfigError(`authz-orm: authz.admin.backend names ${JSON.stringify(name)}, but no AuthzAdminBackend class of that name is registered`);
  const type = entry.type as Class<AuthzAdminBackend>;
  const at = container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? container : entry.container;
  return (await at.resolve(type)) as AuthzAdminBackend;
}

function publishAndAudit(domain: string, container: IContainer, deleted: readonly ResourceRef[], tags: readonly string[]): Promise<void> {
  return (async () => {
    const bus = container.hasRegistered(ChangeBus) ? ((await container.resolve(ChangeBus)) as ChangeBus) : undefined;
    await bus?.publish(Object.freeze({ domain, tags: Object.freeze([...tags]), actor: SYSTEM_REF, at: new Date() }));
    for (const resource of deleted) recordAudit(domain, { kind: 'system', principal: SYSTEM_REF, resource, reason: RESOURCE_DELETED });
  })();
}

/**
 * Design §6.4 steps 3–4, placed by overview decision 20. With DbAuthzAdminBackend the stores write in the
 * statement's transaction (H22's one framework-owned exception) and bump authz_version themselves; any other
 * backend cannot join an ORM transaction, so its forget runs after the commit in its own, best effort.
 */
export async function cleanupDeleted(driver: OrmDriver, deleted: readonly ResourceRef[], domain: string, backendName: string): Promise<void> {
  if (deleted.length === 0) return;
  const container = domainContainer(domain);
  if (backendName === 'DbAuthzAdminBackend') {
    const { tags } = await forgetScopesInTx(container, deleted, { driver }, DELETED);
    await afterCommit(driver, 'publishing the change', () => publishAndAudit(domain, container, deleted, tags));
    return;
  }
  await afterCommit(driver, `forgetting the deleted scopes through ${backendName}`, async () => {
    const backend = await adminBackend(container, backendName);
    const { tags } = await backend.transaction(domain, async (tx) => {
      const out = await forgetScopesInTx(container, deleted, tx, DELETED);
      await backend.bumpVersion(domain, tx);
      return out;
    });
    await publishAndAudit(domain, container, deleted, tags);
  });
}
