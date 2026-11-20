import type { AuditSubject, AuditWriteOptions } from './contracts.js';

/**
 * The kind and action of the record `forget` writes, reserved for it: `record()` refuses them. Verify, arrival blanking
 * and every erasure take exactly this pair as an erasure record, and an erasure never blanks one: it is the evidence of
 * an earlier erasure.
 */
export const ERASURE = { kind: 'custom', action: 'erasure' } as const;

export const isErasureRecord = (e: { readonly kind: string; readonly action: string }): boolean => e.kind === ERASURE.kind && e.action === ERASURE.action;

/** How `forget` records its erasure: a confirmed write of the reserved pair, past the refusal in `record()`. */
export type RecordErasure = (subject: AuditSubject, redacted: number, options: Pick<AuditWriteOptions, 'trail' | 'connection'>) => Promise<void>;
