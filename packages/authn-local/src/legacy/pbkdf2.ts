import { pbkdf2, timingSafeEqual } from 'node:crypto';

// $pbkdf2-sha256$<iterations>$<salt>$<hash>; salt and hash are base64 (standard, URL-safe or passlib's '.' variant), padding optional.
const PBKDF2 = /^\$pbkdf2-sha256\$([1-9]\d{0,8})\$([A-Za-z0-9+/._-]+={0,2})\$([A-Za-z0-9+/._-]+={0,2})$/;

// A stored value is trusted, but an absurd count would pin a thread-pool slot for minutes.
const MAX_ITERATIONS = 10_000_000;
const MAX_KEY_BYTES = 128;

interface ParsedPbkdf2 {
  readonly iterations: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function decode(value: string): Buffer {
  return Buffer.from(value.replace(/\./g, '+'), 'base64');
}

function parse(stored: string): ParsedPbkdf2 | null {
  const match = PBKDF2.exec(stored);
  if (!match) return null;

  const iterations = Number(match[1]);
  const salt = decode(match[2]);
  const key = decode(match[3]);
  if (iterations > MAX_ITERATIONS || salt.length === 0 || key.length === 0 || key.length > MAX_KEY_BYTES) return null;
  return { iterations, salt, key };
}

export function isPbkdf2(stored: string): boolean {
  return parse(stored) !== null;
}

export async function verifyPbkdf2(stored: string, password: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;

  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      pbkdf2(password, parsed.salt, parsed.iterations, parsed.key.length, 'sha256', (err, key) => (err ? reject(err) : resolve(key)));
    });
    return timingSafeEqual(derived, parsed.key);
  } catch {
    return false;
  }
}
