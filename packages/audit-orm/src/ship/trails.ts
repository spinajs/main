import { AuditStore, auditStore, trailConfig, trailNames } from '@spinajs/audit';
import type { TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';

import { OutboxAuditStore } from './outbox-store.js';

/** The trails whose store is an OutboxAuditStore; `only` narrows to one name. */
export async function shippingTrails(only?: string): Promise<TrailConfig[]> {
  const registered = DI.RootContainer.getRegisteredNames(AuditStore);
  const trails: TrailConfig[] = [];
  for (const name of trailNames()) {
    if (only !== undefined && name !== only) continue;
    const trail = trailConfig(name);
    // auditStore throws for a store nobody registered here, and one such trail must not stop the shipper.
    if (!registered.includes(trail.store)) continue;
    if ((await auditStore(trail)) instanceof OutboxAuditStore) trails.push(trail);
  }
  return trails;
}
