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
}

/** 64 lowercase hex digits; `at` enters as epoch milliseconds, the stored value, so a dialect's own date text does not matter. */
export function eventDigest(event: SealedEvent, dataHash: string): string {
  return sha256(JSON.stringify([event.id, event.at.getTime(), event.kind, event.action, event.subject?.type ?? null, event.subject?.id ?? null, event.outcome, event.actor, dataHash]));
}

/** The hash of a seal: the previous seal's hash and the digests of its events, in `seq` order. */
export function sealHash(previous: string | null, digests: readonly string[]): string {
  return sha256([previous ?? '', ...digests].join('\n'));
}
