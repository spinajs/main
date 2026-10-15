import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import { IQueueMessage, QueueMessageType } from '@spinajs/queue';

export function jobMessage(extra: Record<string, unknown> = {}): IQueueMessage {
  return { CreatedAt: DateTime.now(), Name: 'ItRawJob', Type: QueueMessageType.Job, JobId: randomUUID(), Persistent: true, Priority: 0, ...extra } as unknown as IQueueMessage;
}

export function eventMessage(extra: Record<string, unknown> = {}): IQueueMessage {
  return { CreatedAt: DateTime.now(), Name: 'ItRawEvent', Type: QueueMessageType.Event, Persistent: false, Priority: 0, ...extra } as unknown as IQueueMessage;
}

export function jobIdOf(m: IQueueMessage): string {
  return (m as unknown as { JobId: string }).JobId;
}
