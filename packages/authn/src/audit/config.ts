export interface AuditConfig {
  /** HMAC key of DbAuthnThrottle's row keys; unset, or secret null: a random per-process key. */
  readonly hashKey?: { readonly secret: string | null };
  readonly listenerTimeoutMs: number;
}
