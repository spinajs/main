import type { AuditEvent } from '@spinajs/audit';
import { Event, QueueEvent } from '@spinajs/queue';

/** An audit event as JSON: `at` is an ISO 8601 string. */
export type WireAuditEvent = Omit<AuditEvent, 'at'> & { readonly at: string };

/** A batch of audit events on its way to the service that stores them. Delivered at least once; `id` identifies an event. */
@Event()
export class AuditBatchRecorded extends QueueEvent {
  public Trail!: string;
  public Source!: string;
  public Events!: WireAuditEvent[];
}
