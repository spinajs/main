import { AuditContext } from '@spinajs/audit';
import { MemoryAuditStore, TestAuditContext } from '@spinajs/audit/testing';
import { DI } from '@spinajs/di';

/** Who the audit service sees as the actor of the next writes: a test assigns its members and `resetAudit()` clears them. */
export const who = TestAuditContext.who;

/** Clears the actor a test set and everything the memory store of the test trail `recorded` kept. */
export function resetAudit(): void {
  TestAuditContext.reset();
  MemoryAuditStore.clear();
}

DI.register(TestAuditContext).as(AuditContext);
