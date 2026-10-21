import { createHmac } from 'node:crypto';
import { InvalidArgument } from '@spinajs/exceptions';

export const WEBHOOK_SIGNATURE_HEADER = 'Spinajs-Signature';

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signWebhook(secret: string, body: string, now: Date | number = Date.now()): string {
  if (typeof secret !== 'string' || secret === '') throw new InvalidArgument('webhook secret must be a non-empty string', 'secret');
  const t = Math.floor(Number(now) / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
