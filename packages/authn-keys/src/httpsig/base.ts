import { createHash } from 'node:crypto';
import type { SignedRequest } from '@spinajs/authn/contracts';
import { parseByteSequenceDictionary } from './fields.js';
import type { SignatureInput } from './fields.js';

const DERIVED = ['@method', '@target-uri', '@authority', '@path', '@query'];
const HEADER_NAME = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;
// A signature never covers the headers that carry it.
const NOT_COVERABLE = ['signature', 'signature-input'];

export const lowerCaseHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

function componentValue(req: SignedRequest, headers: Record<string, string>, name: string): string | null {
  if (name.startsWith('@')) {
    let url: URL;
    try {
      url = new URL(req.targetUri);
    } catch {
      return null;
    }
    switch (name) {
      case '@method':
        return req.method.toUpperCase();
      case '@target-uri':
        return req.targetUri;
      case '@authority':
        return url.host.toLowerCase();
      case '@path':
        return url.pathname || '/';
      case '@query':
        return url.search || '?';
      default:
        return null;
    }
  }
  const v = headers[name];
  return typeof v === 'string' ? v.trim() : null;
}

/** RFC 9421 §2.5 for the covered components; null when one may not be covered or has no value. */
export function signatureBase(req: SignedRequest, input: SignatureInput): string | null {
  const headers = lowerCaseHeaders(req.headers);
  const lines: string[] = [];
  for (const name of input.components) {
    if (!(DERIVED.includes(name) || (HEADER_NAME.test(name) && !NOT_COVERABLE.includes(name)))) {
      return null;
    }
    const value = componentValue(req, headers, name);
    if (value === null || /[\r\n]/.test(value)) {
      return null;
    }
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${input.value}`);
  return lines.join('\n');
}

const DIGESTS: Readonly<Record<string, string>> = { 'sha-256': 'sha256', 'sha-512': 'sha512' };

/** RFC 9530 Content-Digest: every member is sha-256 or sha-512 and matches the body. */
export function digestMatches(header: unknown, body: Uint8Array): boolean {
  const members = parseByteSequenceDictionary(header);
  if (!members) {
    return false;
  }
  for (const [alg, digest] of members) {
    const hash = DIGESTS[alg];
    if (!hash || !createHash(hash).update(body).digest().equals(digest)) {
      return false;
    }
  }
  return true;
}
