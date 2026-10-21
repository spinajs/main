export const WEBHOOK_SIGNATURE_HEADER = 'Spinajs-Signature';

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signWebhook(_secret: string, _body: string, _now: Date | number = Date.now()): string {
  throw new Error('not implemented: signWebhook');
}
