// Ed25519 point checks that node:crypto skips: `createPublicKey` takes any 32 bytes, and `verify` (cofactorless)
// accepts forgeries under small-order keys. Ported from canvas C8 (`contracts/ts/plane-api/src/ed25519.ts`).

const P = 2n ** 255n - 19n;

const mod = (a: bigint): bigint => ((a % P) + P) % P;

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  for (let b = mod(base), e = exp; e > 0n; b = (b * b) % P, e >>= 1n) {
    if (e & 1n) {
      result = (result * b) % P;
    }
  }
  return result;
}

const D = mod(-121665n * pow(121666n, P - 2n));

/**
 * RFC 8032 §5.1.3 decoding: y < p, x² = (y² − 1) / (d y² + 1) has a root, and x = 0 has no sign bit. The root itself
 * is not needed, so the sqrt(−1) correction reduces to accepting v x² = −u as well as v x² = u.
 */
export function isCanonicalPoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) {
    return false;
  }
  const n = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`);
  const y = n & ((1n << 255n) - 1n);
  if (y >= P) {
    return false;
  }
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  const x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vxx = mod(v * x * x);
  if (vxx !== u && vxx !== mod(-u)) {
    return false;
  }
  return !(u === 0n && n >> 255n === 1n);
}

/** Canonical encodings of the 8 points of order 1, 2, 4 and 8 (canvas C8 `SMALL_ORDER`, checked complete there). */
export const SMALL_ORDER: readonly string[] = Object.freeze(['0100000000000000000000000000000000000000000000000000000000000000', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000080', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa']);

export function isSmallOrder(bytes: Uint8Array): boolean {
  return bytes.length === 32 && SMALL_ORDER.includes(Buffer.from(bytes).toString('hex'));
}
