import { createHash } from 'node:crypto';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** What a seal covers of one event. The payload enters only through its hash, so erasing it leaves the seal intact. */
export interface SealedEvent {
  readonly id: string;
  readonly at: Date;
  readonly kind: string;
  readonly action: string;
  readonly subject?: { readonly type: string; readonly id: string };
  readonly outcome: string;
  readonly actor: string;
  readonly onBehalfOf?: string;
  readonly traceId?: string;
  readonly origin?: string;
  readonly tenant?: string;
  readonly decisionId?: string;
  readonly idempotencyKey?: string;
  readonly dataSubject?: string;
  /** The connection an archive files the event under; absent in a trail's own table. */
  readonly source?: string;
}

/**
 * 64 lowercase hex digits over every stored field but `seq`, which enters through the order of a seal's digests; an
 * absent field is null. `at` enters as epoch milliseconds, the stored value, so a dialect's own date text does not matter.
 */
export function eventDigest(e: SealedEvent, dataHash: string): string {
  return sha256(JSON.stringify([e.id, e.at.getTime(), e.kind, e.action, e.subject?.type ?? null, e.subject?.id ?? null, e.outcome, e.actor, e.onBehalfOf ?? null, e.traceId ?? null, e.origin ?? null, e.tenant ?? null, e.decisionId ?? null, e.idempotencyKey ?? null, e.dataSubject ?? null, e.source ?? null, dataHash]));
}

/** The hash of a seal: the previous seal's hash, its own time as epoch milliseconds, and the digests of its events in `seq` order. */
export function sealHash(previous: string | null, sealedAt: Date, digests: readonly string[]): string {
  return sha256([previous ?? '', String(sealedAt.getTime()), ...digests].join('\n'));
}
