import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { PermanentJobFailure } from '@spinajs/queue';

import type { AuditBatchRecorded } from './event.js';

export interface AuditQueueKey {
  readonly id: string;
  readonly secret: string;
}

interface VerifySettings {
  readonly required: boolean;
  readonly keys: ReadonlyMap<string, readonly AuditQueueKey[]>;
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => v !== null && typeof v === 'object' && !Array.isArray(v);

function keyOf(v: unknown, idField: 'id' | 'keyId'): AuditQueueKey | undefined {
  if (!isRecord(v)) return undefined;
  const id = idField === 'id' ? v.id : v.keyId;
  return typeof id === 'string' && typeof v.secret === 'string' ? { id, secret: v.secret } : undefined;
}

const queueSection = (name: 'signing' | 'verify'): unknown => DI.get(Configuration)?.get<unknown>(['audit', 'queue', name]);

/** The key the sink signs with: `audit.queue.signing`, or none. */
export const signingKey = (): AuditQueueKey | undefined => keyOf(queueSection('signing'), 'keyId');

function verifySettings(): VerifySettings | undefined {
  const v = queueSection('verify');
  if (!isRecord(v) || !isRecord(v.keys)) return undefined;
  const keys = Object.entries(v.keys).map(([source, list]): [string, AuditQueueKey[]] => [source, Array.isArray(list) ? list.flatMap((k) => keyOf(k, 'id') ?? []) : []]);
  return { required: v.required === true, keys: new Map(keys) };
}

/** HMAC-SHA256, base64url, of the canonical JSON of `{ trail, source, events }`, the events as they travel. */
export function batchSignature(secret: string, trail: string, source: string, events: unknown): string {
  return createHmac('sha256', secret).update(canonicalJson({ trail, source, events }), 'utf8').digest('base64url');
}

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

function refusal(message: AuditBatchRecorded, settings: VerifySettings): string | undefined {
  const keyId: unknown = message.KeyId;
  const sig: unknown = message.Sig;
  if (keyId === undefined && sig === undefined) return settings.required ? 'it is not signed and audit.queue.verify.required is set' : undefined;
  if (typeof keyId !== 'string' || typeof sig !== 'string') return 'KeyId and Sig are not both strings';
  const keys = settings.keys.get(message.Source);
  if (keys === undefined) return 'the source is not listed in audit.queue.verify.keys';
  const key = keys.find((k) => k.id === keyId);
  if (key === undefined) return `key ${JSON.stringify(keyId)} is not listed for this source in audit.queue.verify.keys`;
  return sameText(sig, batchSignature(key.secret, message.Trail, message.Source, message.Events)) ? undefined : 'the signature does not match';
}

/**
 * Throws a `PermanentJobFailure` for a batch `audit.queue.verify` refuses, after one error line. Reads the raw message:
 * call it before decoding the events. Without `audit.queue.verify` nothing is checked.
 */
export function checkBatchSignature(message: AuditBatchRecorded): void {
  const settings = verifySettings();
  const reason = settings === undefined ? undefined : refusal(message, settings);
  if (reason === undefined) return;
  const { Trail: trail, Source: source } = message;
  DI.resolve(Log, ['audit-queue']).error({ trail, source, keyId: message.KeyId, reason }, 'audit: refused AuditBatchRecorded of trail ${trail} from source ${source}: ${reason}');
  throw new PermanentJobFailure('audit_signature', `audit: refused AuditBatchRecorded of trail ${JSON.stringify(trail)} from source ${JSON.stringify(source)}: ${reason}`);
}
