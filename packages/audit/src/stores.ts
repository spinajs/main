import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AuditStore } from './contracts.js';
import type { TrailConfig } from './contracts.js';
import { AuditConfigError } from './errors.js';
import { quoted } from './guards.js';

/** The store a trail names, by registration name in the lineage of `container`. Looked up on every use, so a test or a reload can switch it. */
export async function auditStore(trail: TrailConfig, container: IContainer = DI.RootContainer): Promise<AuditStore> {
  const registered = container.getRegisteredNames(AuditStore);
  if (!registered.includes(trail.store)) {
    const hint = trail.store === 'TableAuditStore' ? "; TableAuditStore is registered by @spinajs/audit-orm: install and import it, or set the trail's store to LogAuditStore" : '';
    throw new AuditConfigError(`audit: trail ${quoted(trail.name)} names the store ${quoted(trail.store)}, and no AuditStore is registered under that name (registered: ${registered.join(', ') || 'none'})${hint}`);
  }
  return container.resolveNamed(AuditStore, trail.store);
}
