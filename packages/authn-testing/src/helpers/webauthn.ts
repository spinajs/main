import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** The members of a registration response (W3C WebAuthn `RegistrationResponseJSON`) the kit's authenticator fills. */
export interface SoftRegistrationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: { readonly clientDataJSON: string; readonly attestationObject: string; readonly transports: readonly string[] };
  readonly clientExtensionResults: Readonly<Record<string, never>>;
  readonly authenticatorAttachment: 'platform';
}

/** The members of an assertion response (W3C WebAuthn `AuthenticationResponseJSON`) the kit's authenticator fills. */
export interface SoftAssertionResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: { readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string; readonly userHandle?: string };
  readonly clientExtensionResults: Readonly<Record<string, never>>;
  readonly authenticatorAttachment: 'platform';
}

export interface SoftAuthenticatorOptions {
  /** Seeds the Ed25519 key and the credential id, so the same seed gives the same credential. */
  readonly seed?: string;
  /** Default: user verification is performed. */
  readonly uv?: boolean;
  /** Signature counter before the first assertion; 0 keeps it at 0, as many passkey providers do. */
  readonly counter?: number;
}

/** The parts of server options the authenticator reads: `PublicKeyCredentialCreationOptionsJSON` and `...RequestOptionsJSON`. */
export interface SoftCreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
  readonly user: { readonly id: string };
}

export interface SoftRequestOptions {
  readonly challenge: string;
  readonly rpId?: string;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
// RFC 8410: the PKCS#8 prefix of a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const KIT_AAGUID = Buffer.from('6b69742d736f66742d61757468656e00', 'hex');

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([(major << 5) | 26]), u32(n)]);
}

type Cbor = number | string | Uint8Array | ReadonlyMap<number | string, Cbor> | readonly Cbor[];

/** The CBOR subset WebAuthn needs: small integers, text, bytes, arrays and maps (RFC 8949). */
export function cborEncode(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const bytes = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cborEncode)]);
  const entries = [...(v as ReadonlyMap<number | string, Cbor>)];
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
}

/**
 * A platform authenticator in software for WebAuthn tests: one discoverable Ed25519 credential (COSE alg -8), `none`
 * attestation, a signature counter. Ed25519 signatures are deterministic, so a seed and a challenge give the same bytes
 * on every run.
 */
export class SoftAuthenticator {
  readonly credentialId: string;
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  private counter: number;
  private userHandle: string | undefined;
  private readonly uv: boolean;

  constructor(opts: SoftAuthenticatorOptions = {}) {
    const seed = sha256(`kit-webauthn-key:${opts.seed ?? 'default'}`);
    this.privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey(this.privateKey);
    this.credentialId = b64url(sha256(`kit-webauthn-credential:${opts.seed ?? 'default'}`));
    this.counter = opts.counter ?? 1;
    this.uv = opts.uv ?? true;
  }

  /** The signature counter of the last assertion. */
  get signCount(): number {
    return this.counter;
  }

  /** The credential's public key as COSE_Key bytes (OKP, EdDSA, Ed25519), as an attestation carries it. */
  cosePublicKey(): Uint8Array {
    const x = Buffer.from(this.publicKey.export({ format: 'jwk' }).x!, 'base64url');
    return cborEncode(
      new Map<number, Cbor>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, x],
      ]),
    );
  }

  /** The user handle a later assertion returns; set by `create`, or here for a credential seeded without one. */
  bindUser(userHandle: string): void {
    this.userHandle = userHandle;
  }

  /** navigator.credentials.create() on `options`, answered as from `origin`. */
  create(options: SoftCreationOptions, origin: string, over: { uv?: boolean } = {}): SoftRegistrationResponse {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }), 'utf8');
    const rawId = Buffer.from(this.credentialId, 'base64url');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(rawId.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(over.uv) | FLAG_AT]), u32(0), KIT_AAGUID, length, rawId, this.cosePublicKey()]);
    const attestationObject = cborEncode(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() on `options`, answered as from `origin`; each call advances a non-zero counter by one. */
  get(options: SoftRequestOptions, origin: string, over: { uv?: boolean } = {}): SoftAssertionResponse {
    const rpId = options.rpId ?? new URL(origin).hostname;
    if (this.counter > 0) this.counter++;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }), 'utf8');
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(over.uv)]), u32(this.counter)]);
    const signature = sign(null, Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature), ...(this.userHandle !== undefined ? { userHandle: this.userHandle } : {}) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  private flags(uv: boolean | undefined): number {
    return FLAG_UP | ((uv ?? this.uv) ? FLAG_UV : 0);
  }
}
