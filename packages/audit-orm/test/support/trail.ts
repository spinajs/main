import { audit } from '@spinajs/audit';
import type { AuditAppend, StoredAuditEvent } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';

export class TestAuditStore extends MemoryAuditStore {
  public static calls = 0;

  public override append(write: AuditAppend): Promise<void> {
    TestAuditStore.calls++;
    return super.append(write);
  }
}

/** The events of a trail, after the deferred buffer was written out. */
export async function recorded(trail: string): Promise<readonly StoredAuditEvent[]> {
  await audit().flush();
  return MemoryAuditStore.events(trail);
}

export function resetTrail(): void {
  TestAuditStore.calls = 0;
  MemoryAuditStore.clear();
}
