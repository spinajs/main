import { InvalidOption } from '@spinajs/exceptions';

export interface AuditConfig {
  /** Sinks that must be registered; they run first, in this order. */
  readonly sinks: readonly string[] | undefined;
  readonly sampleUse: number;
  readonly hashIdentifiers: boolean;
  /** HMAC key of LogAuthnAuditSink; null: a random per-process key. */
  readonly hashKey: string | null;
  readonly sinkTimeoutMs: number;
}

export const DEFAULT_AUDIT_SAMPLE_USE = 0.01;

export const MIN_AUDIT_HASH_KEY_LENGTH = 32;

export const DEFAULT_AUDIT_SINK_TIMEOUT_MS = 2000;

export const MAX_AUDIT_SINK_TIMEOUT_MS = 60000;

const KEYS = ['sinks', 'sampleUse', 'hashIdentifiers', 'hashKey', 'sinkTimeoutMs'];

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const unknownKeys = (o: Record<string, unknown>, known: readonly string[]): string[] => Object.keys(o).filter((k) => !known.includes(k));

// Errors name keys and value types only: hashKey is a secret.
function readHashKey(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new InvalidOption(`authn.audit.hashKey must be a { secret } object, got ${kindOf(raw)}`);
  const extra = unknownKeys(raw, ['secret']);
  if (extra.length > 0) throw new InvalidOption(`authn.audit.hashKey: unknown key ${JSON.stringify(extra[0])}`);
  const secret = raw.secret;
  if (secret === undefined || secret === null) return null;
  if (typeof secret !== 'string') throw new InvalidOption(`authn.audit.hashKey.secret must be a string or null, got ${kindOf(secret)}`);
  if (secret.length < MIN_AUDIT_HASH_KEY_LENGTH) throw new InvalidOption(`authn.audit.hashKey.secret must be at least ${MIN_AUDIT_HASH_KEY_LENGTH} characters`);
  return secret;
}

/** Reads `authn.audit` strictly: an unknown key or a bad value fails boot, so a typo cannot turn auditing down. */
export function readAuditConfig(raw: unknown): AuditConfig {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) throw new InvalidOption(`authn.audit must be an object, got ${kindOf(raw)}`);
  const extra = unknownKeys(raw, KEYS);
  if (extra.length > 0) throw new InvalidOption(`authn.audit: unknown key ${JSON.stringify(extra[0])}`);

  const { sinks, sampleUse, hashIdentifiers, sinkTimeoutMs } = raw;
  if (sinks !== undefined && sinks !== null && (!Array.isArray(sinks) || !sinks.every((s) => typeof s === 'string' && s !== ''))) {
    throw new InvalidOption('authn.audit.sinks must be a list of non-empty sink service names');
  }
  if (sampleUse !== undefined && sampleUse !== null && (typeof sampleUse !== 'number' || !(sampleUse >= 0 && sampleUse <= 1))) {
    throw new InvalidOption(`authn.audit.sampleUse must be a number from 0 to 1, got ${kindOf(sampleUse)}`);
  }
  if (hashIdentifiers !== undefined && hashIdentifiers !== null && typeof hashIdentifiers !== 'boolean') {
    throw new InvalidOption(`authn.audit.hashIdentifiers must be a boolean, got ${kindOf(hashIdentifiers)}`);
  }
  if (sinkTimeoutMs !== undefined && sinkTimeoutMs !== null && (!Number.isInteger(sinkTimeoutMs) || (sinkTimeoutMs as number) < 1 || (sinkTimeoutMs as number) > MAX_AUDIT_SINK_TIMEOUT_MS)) {
    throw new InvalidOption(`authn.audit.sinkTimeoutMs must be an integer from 1 to ${MAX_AUDIT_SINK_TIMEOUT_MS}, got ${kindOf(sinkTimeoutMs)}`);
  }
  return {
    sinks: Array.isArray(sinks) ? [...(sinks as string[])] : undefined,
    sampleUse: typeof sampleUse === 'number' ? sampleUse : DEFAULT_AUDIT_SAMPLE_USE,
    hashIdentifiers: typeof hashIdentifiers === 'boolean' ? hashIdentifiers : true,
    hashKey: readHashKey(raw.hashKey),
    sinkTimeoutMs: typeof sinkTimeoutMs === 'number' ? sinkTimeoutMs : DEFAULT_AUDIT_SINK_TIMEOUT_MS,
  };
}
