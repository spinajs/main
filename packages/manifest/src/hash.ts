import { createHash } from 'node:crypto';
import type { Manifest } from './types.js';

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashManifest(manifest: Manifest): string {
  return createHash('sha256')
    .update(canonicalize({ ...manifest, hash: '', generatedAt: '' }))
    .digest('hex');
}
