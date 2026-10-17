# Crypto helpers

Hashing, constant-time comparison, strict base64/base64url/base32 codecs, random tokens and key parsing, shared by the authn packages.

They live in the Node-only subpath `@spinajs/util/crypto`, not in the package root, so the root stays importable where `node:crypto` is not available:

```ts
import { sha256, randomToken, timingSafeEqualDigest } from '@spinajs/util/crypto';
```

## How it works

Strings passed as data are taken as their UTF-8 bytes. Digests are hex unless `enc` says `'base64url'` or `'buffer'`. A bad argument (wrong type, unknown encoding, size out of range) throws `InvalidArgument`. The decoders never throw: they return `null` for anything but the one form they accept.

### Hashing and comparison

| Function | Behaviour |
| --- | --- |
| `sha256(data, enc = 'hex')` | SHA-256 as hex, base64url or a `Buffer` |
| `hmacSha256(key, data, enc = 'hex')` | HMAC-SHA-256; a string key is its UTF-8 bytes |
| `taggedHash(tag, value, len = 64)` | First `len` hex characters of SHA-256 of `` `${tag}\0${value}` ``: a fingerprint that cannot collide with another tag's, e.g. to log a session id whose plain SHA-256 is its storage key. `tag` must be non-empty and free of NUL; `len` is 1 to 64 |
| `timingSafeEqualStr(a, b)` | Constant-time comparison of the UTF-8 bytes; the length can still show in the timing. `false` for a non-string |
| `timingSafeEqualDigest(a, b)` | Compares the SHA-256 digests of both sides, so neither the length nor the first differing byte shows. Use it for secrets that differ in length, such as configured tokens. `false` for a value that is neither a string nor a `Uint8Array` |

### Encodings

| Function | Accepts |
| --- | --- |
| `encodeB64url(data)` / `decodeB64url(text)` | Unpadded base64url (RFC 4648 §5). The decoder refuses padding, the standard alphabet and non-zero unused bits, so every value has exactly one text form |
| `decodeBase64Strict(text)` | Padded standard base64 (RFC 4648 §4) with zero unused bits, the form RFC 8941 byte sequences use |
| `base32Encode(data, { pad })` / `base32Decode(text)` | RFC 4648 §6 base32. The encoder writes upper case, unpadded unless `pad: true`. The decoder takes upper case only, with no padding or exactly the padding the length needs, and zero unused bits |

### Random values and keys

| Function | Behaviour |
| --- | --- |
| `randomToken(bytes = 32, enc = 'base64url')` | `bytes` random bytes as unpadded base64url or hex |
| `processSecret()` | A 32-byte random key made on first use and kept for the life of the process, for keying in-process HMACs (throttle keys, audit fingerprints) when no secret is configured. Each call returns a copy |
| `parseKeyMaterial(text, bytes = 32)` | A key of exactly `bytes` bytes given as hex (either case), standard base64 (padded or not) or unpadded base64url; `null` for anything else, including a mix of the two base64 alphabets and non-zero unused bits |

### Compare a presented token with configured ones

```ts sample
import { parseKeyMaterial, taggedHash, timingSafeEqualDigest } from '@spinajs/util/crypto';
import { InvalidOption } from '@spinajs/exceptions';

const configured = ['svc-token-1', 'a-longer-svc-token-2'];

function matches(presented: string): boolean {
  // `some` stops early, which only reveals which entry matched, not the token
  return configured.some((t) => timingSafeEqualDigest(presented, t));
}

const key = parseKeyMaterial(process.env.APP_KEY ?? '');
if (!key) {
  throw new InvalidOption('APP_KEY must be 32 bytes given as hex, base64 or base64url');
}

console.log(matches('svc-token-1'), taggedHash('app:log', 'session-123', 16));
```

## Important behaviour

- Nothing here is exported from `@spinajs/util`; import from `@spinajs/util/crypto`.
- `processSecret()` is per module copy: a process that loads both the ESM and the CommonJS build gets two different secrets. Values keyed with it do not survive a restart, so never store them.
- `parseKeyMaterial` returns `null` rather than throwing, so the caller words the error for its own config key. Do not put the rejected value in that message.
- `taggedHash` output is a fingerprint, not a MAC: anyone who knows the input can recompute it. Use `hmacSha256` under a secret when the input is guessable.

## Related

- [Strings, functions and type guards](13-strings-functions-and-type-guards.md): the non-crypto string helpers.
- [`@spinajs/exceptions`](../exceptions/README.md): `InvalidArgument`, thrown for a bad argument.
