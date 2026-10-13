export interface AuditConfig {
  readonly hashIdentifiers: boolean;
  /** HMAC key of LogAuthnAuditSink; unset, or secret null: a random per-process key. */
  readonly hashKey?: { readonly secret: string | null };
  readonly sinkTimeoutMs: number;
}
