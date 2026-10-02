import { createHmac } from 'node:crypto';

type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648; padding optional, case-insensitive. */
export function base32Decode(s: string): Buffer {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) {
      throw new Error(`invalid base32 character '${ch}'`);
    }
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function parseOtpauth(uri: string): { secret: string; algorithm: OtpAlgorithm; digits: number; period: number } {
  const q = new URL(uri).searchParams;
  const secret = q.get('secret');
  if (!secret) {
    throw new Error('otpauth URI has no secret');
  }
  const algorithm = (q.get('algorithm') ?? 'SHA1').toUpperCase();
  if (algorithm !== 'SHA1' && algorithm !== 'SHA256' && algorithm !== 'SHA512') {
    throw new RangeError(`unsupported otpauth algorithm ${algorithm}`);
  }
  const positive = (name: string, fallback: number): number => {
    const n = Number(q.get(name) ?? fallback);
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`invalid otpauth ${name}`);
    }
    return n;
  };
  return { secret, algorithm, digits: positive('digits', 6), period: positive('period', 30) };
}

/** RFC 6238 over RFC 4226 dynamic truncation. */
export function totp(secretBase32: string, at: Date, o: { digits?: number; period?: number; algorithm?: OtpAlgorithm } = {}): string {
  const digits = o.digits ?? 6;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 1000 / (o.period ?? 30))));
  const mac = createHmac((o.algorithm ?? 'SHA1').toLowerCase(), base32Decode(secretBase32))
    .update(counter)
    .digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export function totpFromProvisioning(uri: string, at: Date): string {
  const { secret, ...rest } = parseOtpauth(uri);
  return totp(secret, at, rest);
}
