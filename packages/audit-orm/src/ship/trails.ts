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
    try {
      const trail = trailConfig(name);
      // auditStore throws for a store nobody registered here.
      if (registered.includes(trail.store) && (await auditStore(trail)) instanceof OutboxAuditStore) trails.push(trail);
    } catch {
      // An invalid trail fails where it is written, not in the shipper of every other trail.
    }
  }
  return trails;
}
