import type { OrmDriver } from '@spinajs/orm';

import { oldestBuffered } from './outbox.js';
import { bufferConnections } from './ship.js';
import type { ShipOptions } from './ship.js';
import { AUDIT_OUTBOX_TABLE } from './table.js';
import { shippingTrails } from './trails.js';

export interface AuditBacklog {
  readonly trail: string;
  readonly connection: string;
  readonly pending: number;
  readonly oldestAt: Date | null;
}

async function backlogOf(driver: OrmDriver, trail: string): Promise<AuditBacklog> {
  const pending = await driver.select().from(AUDIT_OUTBOX_TABLE).where('trail', trail).selectCount();
  const [oldest] = await oldestBuffered(driver, trail, 1);
  return { trail, connection: driver.Options.Name, pending, oldestAt: oldest?.event.at ?? null };
}

/** What each shipping trail still has buffered on each connection: the figure a health check or an alert reads. */
export async function auditBacklog(options: ShipOptions = {}): Promise<readonly AuditBacklog[]> {
  const trails = await shippingTrails(options.trail);
  if (trails.length === 0) return [];
  const drivers = await bufferConnections(options.connection);
  const out: AuditBacklog[] = [];
  // spinajs-orm-ignore ORM102: two statements per trail and connection, for a health check
  for (const trail of trails) {
    for (const driver of drivers) out.push(await backlogOf(driver, trail.name));
  }
  return out;
}
