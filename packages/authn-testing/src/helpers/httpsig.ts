import { createHash, sign } from 'node:crypto';
import type { SignedRequest } from '@spinajs/authn/contracts';
import type { KitKeyPair } from '../harness/index.js';

export interface HttpSigParams {
  readonly created?: number;
  readonly expires?: number;
  readonly nonce?: string;
  /** Default: the kid argument; null omits it. */
  readonly keyid?: string | null;
  /** Default: all three when a body exists, else the first two. */
  readonly components?: readonly ('@method' | '@target-uri' | 'content-digest')[];
  /** Default 'sig1'. */
  readonly label?: string;
}

/** RFC 9530: 'sha-256=:<base64>:'. */
export function contentDigest(body: Uint8Array): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

function componentValue(req: { method: string; targetUri: string; headers: Record<string, string> }, name: string): string {
  const url = (): URL => new URL(req.targetUri);
  switch (name) {
    case '@method':
      return req.method.toUpperCase();
    case '@target-uri':
      return req.targetUri;
    case '@authority':
      return url().host.toLowerCase();
    case '@path':
      return url().pathname || '/';
    case '@query':
      return url().search || '?';
    default: {
      const v = req.headers[name];
      if (v === undefined) {
        throw new Error(`signature component '${name}' has no value`);
      }
      return v.trim();
    }
  }
}

/** RFC 9421 §2.5. `paramsString` is the inner list and its parameters, e.g. `("@method");created=1`. */
export function signatureBase(req: { method: string; targetUri: string; headers: Record<string, string> }, components: readonly string[], paramsString: string): string {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const lines = components.map((c) => `"${c}": ${componentValue({ ...req, headers }, c)}`);
  lines.push(`"@signature-params": ${paramsString}`);
  return lines.join('\n');
}

/** Adds content-digest (with a body), signature-input and signature. Ed25519 or ecdsa-p256-sha256 (ieee-p1363); no alg parameter. */
export function signHttpRequest(req: { method: string; targetUri: string; headers?: Record<string, string>; body?: Uint8Array }, key: KitKeyPair, kid: string | null, p: HttpSigParams): SignedRequest {
  const headers: Record<string, string> = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (req.body) {
    headers['content-digest'] = contentDigest(req.body);
  }
  const components = p.components ?? (req.body ? ['@method', '@target-uri', 'content-digest'] : ['@method', '@target-uri']);
  const keyid = p.keyid === undefined ? kid : p.keyid;
  let params = `(${components.map((c) => `"${c}"`).join(' ')})`;
  if (p.created !== undefined) params += `;created=${p.created}`;
  if (p.expires !== undefined) params += `;expires=${p.expires}`;
  if (p.nonce !== undefined) params += `;nonce="${p.nonce}"`;
  if (keyid !== null) params += `;keyid="${keyid}"`;

  const base = Buffer.from(signatureBase({ method: req.method, targetUri: req.targetUri, headers }, components, params));
  const signature = key.alg === 'EdDSA' ? sign(null, base, key.privateKey) : sign('sha256', base, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  const label = p.label ?? 'sig1';
  headers['signature-input'] = `${label}=${params}`;
  headers.signature = `${label}=:${signature.toString('base64')}:`;
  return { method: req.method, targetUri: req.targetUri, headers, ...(req.body ? { body: req.body } : {}) };
}
