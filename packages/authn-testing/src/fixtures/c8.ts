import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { JwsErrorCode } from '@spinajs/authn/contracts';

export type C8ErrorCode = JwsErrorCode;

const CODES: Record<C8ErrorCode, true> = {
  malformed: true,
  bad_header: true,
  unknown_key: true,
  bad_signature: true,
  invalid_claims: true,
  wrong_issuer: true,
  wrong_audience: true,
  expired: true,
  not_yet_valid: true,
};
export const C8_ERROR_CODES = Object.keys(CODES) as C8ErrorCode[];

export interface C8Jwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly kid: string;
  readonly x: string;
  readonly d?: string;
}

export interface C8KeysFile {
  readonly warning: string;
  readonly signing: readonly (C8Jwk & { readonly d: string })[];
  readonly jwks: { readonly keys: readonly C8Jwk[] };
}

export interface C8ValidTicket {
  readonly name: string;
  readonly kid: string;
  readonly now: number;
  readonly claims: Record<string, unknown>;
  readonly token: string;
}

export interface C8InvalidTicket {
  readonly name: string;
  readonly now: number;
  readonly error: C8ErrorCode;
  readonly token: string;
}

export interface C8TicketsFile {
  readonly valid: readonly C8ValidTicket[];
  readonly invalid: readonly C8InvalidTicket[];
}

export const C8_SOURCE = {
  repo: 'https://gitlab.coderush.pl/coderush/canvas.git',
  branch: 'foundation/f06-c8-plane-api',
  commit: '5157a618802c9702f8baa5fbb4b010a8550b3339',
  lastChanged: '27eb8cf069f6a95a13771dcf7d39d5ebc10f56f5',
  files: {
    'keys.json': { sha256: 'a4477d2c38a4a36bdcbd440632e30c4863ff07e95dfae7c0825a5e102c1becb3', size: 729 },
    'tickets.json': { sha256: '907762fafaf8e893ac2225aec370892266fb91d0069212dea18d86ba49bd30d4', size: 34799 },
  },
} as const;

function readVerified(dir: string, file: keyof typeof C8_SOURCE.files): string {
  const bytes = readFileSync(join(dir, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== C8_SOURCE.files[file].sha256) {
    throw new Error(`C8 fixture ${file} in ${dir} has sha256 ${sha256}, expected ${C8_SOURCE.files[file].sha256} (canvas ${C8_SOURCE.commit}); the copy was changed or re-encoded`);
  }
  return bytes.toString('utf8');
}

/** Without `dir`, the package's own `fixtures/c8/`, found by package name from the cwd (neither import.meta nor __dirname works in both builds). */
export function loadC8Fixtures(dir?: string): { keys: C8KeysFile; tickets: C8TicketsFile } {
  const root = dir ?? dirname(createRequire(`${process.cwd()}/`).resolve('@spinajs/authn-testing/fixtures/c8/keys.json'));
  return {
    keys: JSON.parse(readVerified(root, 'keys.json')) as C8KeysFile,
    tickets: JSON.parse(readVerified(root, 'tickets.json')) as C8TicketsFile,
  };
}
