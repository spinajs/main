import { AuditConfigError, AuditEventSink } from '@spinajs/audit';
import type { AuditBatch } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { BlackHoleQueueClient, QueueService } from '@spinajs/queue';

import { AuditBatchRecorded } from './event.js';
import type { WireAuditEvent } from './event.js';
import { batchSignature, signingKey } from './signing.js';

const DEFAULT_MAX_BYTES = 200000;
// Room for the message envelope (name, type, ids, headers, trail, source) around the events.
const ENVELOPE_BYTES = 512;

function maxMessageBytes(): number {
  const v = DI.get(Configuration)?.get<unknown>(['audit', 'queue', 'maxMessageBytes']);
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 ? v : DEFAULT_MAX_BYTES;
}

function connectionOf(route: unknown): string | undefined {
  if (typeof route !== 'object' || route === null || !('connection' in route)) return undefined;
  return typeof route.connection === 'string' ? route.connection : undefined;
}

/** The connections QueueService sends an event of this name to: `queue.routing.<name>`, else `queue.default`. */
export function routedConnections(eventName: string): string[] {
  const cfg = DI.get(Configuration);
  const fallback = cfg?.get<unknown>(['queue', 'default']);
  const route = cfg?.get<unknown>(['queue', 'routing', eventName]);
  const routes: unknown[] = Array.isArray(route) ? route : [route];
  return [...new Set(routes.map((r) => connectionOf(r) ?? (typeof fallback === 'string' ? fallback : '')))];
}

/**
 * Cuts `events` into parts that each fit one message, in order; an event that cannot fit alone is refused. `reserved`
 * is envelope room on top of the usual, such as a signature's.
 */
export function splitBySize(trail: string, events: readonly WireAuditEvent[], limit: number, reserved = 0): WireAuditEvent[][] {
  const envelope = ENVELOPE_BYTES + reserved;
  const parts: WireAuditEvent[][] = [];
  let part: WireAuditEvent[] = [];
  let size = envelope;
  for (const e of events) {
    // One more byte for the comma between two events.
    const bytes = Buffer.byteLength(JSON.stringify(e)) + 1;
    if (bytes + envelope > limit) throw new InvalidOperation(`audit: event ${e.id} of trail ${JSON.stringify(trail)} is ${bytes} bytes, over audit.queue.maxMessageBytes (${limit})`);
    if (part.length > 0 && size + bytes > limit) {
      parts.push(part);
      part = [];
      size = envelope;
    }
    part.push(e);
    size += bytes;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

/**
 * Publishes a shipped batch as AuditBatchRecorded events and returns when every part was emitted: the broker holds them
 * then only on a transport whose emit waits for its confirmation (AMQP, SQS).
 */
@Injectable(AuditEventSink)
export class QueueAuditSink extends AuditEventSink {
  async deliver(batch: AuditBatch): Promise<void> {
    const queue = await DI.resolve(QueueService);
    for (const name of routedConnections(AuditBatchRecorded.name)) {
      // The shipped default connection accepts and drops every message: delivering there would empty the buffer into nothing.
      if (queue.get(name) instanceof BlackHoleQueueClient) throw new AuditConfigError(`audit: AuditBatchRecorded is routed to the black-hole queue connection ${JSON.stringify(name)}; set queue.routing.AuditBatchRecorded to a real connection before shipping audit events`);
    }
    const wire = batch.events.map((e): WireAuditEvent => ({ ...e, at: e.at.toISOString() }));
    const key = signingKey();
    const signature = (events: WireAuditEvent[]) => (key === undefined ? {} : { KeyId: key.id, Sig: batchSignature(key.secret, batch.trail, batch.source, events) });
    // The members join the envelope: its braces go, one comma comes. A signature has the same length for every part.
    const reserved = key === undefined ? 0 : Buffer.byteLength(JSON.stringify(signature([]))) - 1;
    for (const part of splitBySize(batch.trail, wire, maxMessageBytes(), reserved)) {
      // Persistent: a broker that keeps messages on disk (AMQP) does so only for persistent ones.
      await queue.emit(new AuditBatchRecorded({ Trail: batch.trail, Source: batch.source, Events: part, Persistent: true, ...signature(part) }));
    }
  }
}
