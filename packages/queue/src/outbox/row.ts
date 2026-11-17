import { DateTime } from 'luxon';
import { QueueHeaders } from '../headers.js';
import { QueueMessageType, type IQueueMessage } from '../interfaces.js';

export const OUTBOX_TABLE = 'queue_outbox';

/** Width of `queue_outbox.MessageId`; a MessageId is caller-supplied, so the writer checks it. */
export const OUTBOX_MESSAGE_ID_MAX = 128;

// W3C trace context, version 00: the only shape the TraceParent column (55 characters) holds
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export type OutboxStatus = 'pending' | 'published' | 'dead';

export interface OutboxRow {
  Id: number;
  MessageId: string;
  Name: string;
  Type: string;
  Message: string;
  Status: OutboxStatus;
  Attempts: number;
  AvailableAt: number;
  CreatedAt: number;
  PublishedAt: number | null;
  /** Queue connections that already confirmed the message; a retry skips them. */
  PublishedTo: string[];
  LastError: string | null;
  TraceParent: string | null;
  ClaimedBy: string | null;
  ClaimedUntil: number | null;
  ClaimEpoch: number;
}

export type NewOutboxRow = Pick<OutboxRow, 'MessageId' | 'Name' | 'Type' | 'Message' | 'Status' | 'Attempts' | 'AvailableAt' | 'CreatedAt' | 'TraceParent' | 'ClaimEpoch'>;

const STATUSES: readonly OutboxStatus[] = ['pending', 'published', 'dead'];

const text = (v: unknown): string => (typeof v === 'string' ? v : String(v));
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));
const numberOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function status(v: unknown): OutboxStatus {
  const found = STATUSES.find((s) => s === v);
  if (!found) throw new TypeError(`queue_outbox: unknown Status ${text(v)}`);
  return found;
}

function publishedTo(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  const parsed: unknown = JSON.parse(text(v));
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
}

export function newOutboxRow(message: IQueueMessage, messageId: string, now: number): NewOutboxRow {
  const traceparent = message.Headers?.[QueueHeaders.TraceParent];
  return {
    MessageId: messageId,
    Name: message.Name,
    Type: message.Type,
    Message: JSON.stringify({ ...message, CreatedAt: DateTime.isDateTime(message.CreatedAt) ? message.CreatedAt : DateTime.fromMillis(now) }),
    Status: 'pending',
    Attempts: 0,
    AvailableAt: now,
    CreatedAt: now,
    TraceParent: traceparent !== undefined && TRACEPARENT.test(traceparent) ? traceparent : null,
    ClaimEpoch: 0,
  };
}

/** BIGINT columns come back as strings on Postgres. */
export function toOutboxRow(raw: Record<string, unknown>): OutboxRow {
  return {
    Id: Number(raw.Id),
    MessageId: text(raw.MessageId),
    Name: text(raw.Name),
    Type: text(raw.Type),
    Message: text(raw.Message),
    Status: status(raw.Status),
    Attempts: Number(raw.Attempts),
    AvailableAt: Number(raw.AvailableAt),
    CreatedAt: Number(raw.CreatedAt),
    PublishedAt: numberOrNull(raw.PublishedAt),
    PublishedTo: publishedTo(raw.PublishedTo),
    LastError: textOrNull(raw.LastError),
    TraceParent: textOrNull(raw.TraceParent),
    ClaimedBy: textOrNull(raw.ClaimedBy),
    ClaimedUntil: numberOrNull(raw.ClaimedUntil),
    ClaimEpoch: Number(raw.ClaimEpoch),
  };
}

/** A queue message as `newOutboxRow` stores it: `CreatedAt` is an ISO string. */
type StoredMessage = Omit<IQueueMessage, 'CreatedAt'> & { CreatedAt: string };

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== 'object' || value === null) return false;
  if (!('Name' in value) || typeof value.Name !== 'string') return false;
  if (!('Type' in value) || (value.Type !== QueueMessageType.Job && value.Type !== QueueMessageType.Event)) return false;
  return 'CreatedAt' in value && typeof value.CreatedAt === 'string';
}

/** The message a row holds, with `CreatedAt` as a DateTime again. */
export function hydrateOutboxMessage(json: string): IQueueMessage {
  const parsed: unknown = JSON.parse(json);
  if (!isStoredMessage(parsed)) throw new TypeError('queue_outbox: Message is not a serialized queue message');
  return { ...parsed, CreatedAt: DateTime.fromISO(parsed.CreatedAt) };
}
