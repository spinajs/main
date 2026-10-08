export interface AuditConfig {
  readonly sampleUse: number;
  readonly hashIdentifiers: boolean;
  /** HMAC key of LogAuthnAuditSink; unset, or secret null: a random per-process key. */
  readonly hashKey?: { readonly secret: string | null };
  readonly sinkTimeoutMs: number;
}

export const DEFAULT_AUDIT_SAMPLE_USE = 0.01;

export const MIN_AUDIT_HASH_KEY_LENGTH = 32;

export const DEFAULT_AUDIT_SINK_TIMEOUT_MS = 2000;

export const MAX_AUDIT_SINK_TIMEOUT_MS = 60000;
