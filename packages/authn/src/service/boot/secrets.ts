import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { MfaStepRegistry } from '../../flow/mfa-step-registry.js';
import { isSecretStoringMfaStep } from '../../flow/secret-storing-step.js';
import { AUTHN_PUBLIC_COOKIE_SECRET, authnAppEnv, isLenientAuthnEnv } from './env.js';
import type { AuthnConfigSource } from './env.js';

/** One finding of the boot checks and of authn:check-config. */
export interface AuthnConfigFinding {
  readonly topic: 'strategies' | 'secrets' | 'proxy' | 'cors' | 'env' | 'mfa' | 'legacy';
  readonly level: 'error' | 'warning';
  readonly message: string;
}

/** Names of the configured MFA steps that store secrets (D3). */
export type SecretStoringSteps = () => Promise<readonly string[]>;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const absent = (v: unknown): v is undefined | null => v === undefined || v === null;

const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

const q = (v: string): string => JSON.stringify(v);

/**
 * Our readers' InvalidOption messages name keys, names and services only; another error may echo a value, so only its
 * class is given, with `during` saying what failed.
 */
export const safeMessage = (e: unknown, during: string): string => (e instanceof InvalidOption ? e.message : `${e instanceof Error ? e.name : typeof e} while ${during}`);

/** The names of the listed MFA steps that declare `storesSecrets: true`; resolving the steps may fail boot. */
export async function secretStoringSteps(container: IContainer): Promise<string[]> {
  const steps = (await container.resolve(MfaStepRegistry)).steps();
  return steps.filter(isSecretStoringMfaStep).map((s) => s.name);
}

/**
 * The A24/SR-16 secret checks. A missing, empty or public secret is an error outside development and test and a
 * warning there; a malformed setting is an error in every env. Messages name keys, never values. `steps` is asked
 * only when the MFA key is missing; steps that cannot be resolved count as a missing key.
 */
export async function authnSecretFindings(config: AuthnConfigSource, steps: SecretStoringSteps): Promise<AuthnConfigFinding[]> {
  const env = authnAppEnv(config);
  const lenient = isLenientAuthnEnv(env);
  const out: AuthnConfigFinding[] = [];
  const error = (message: string): void => {
    out.push({ topic: 'secrets', level: 'error', message });
  };
  const weak = (message: string): void => {
    out.push({ topic: 'secrets', level: lenient ? 'warning' : 'error', message: lenient ? message : `${message} (env ${q(env ?? 'unset')})` });
  };

  const cookie = config.get<unknown>('http.cookie.secret');
  if (!absent(cookie) && typeof cookie !== 'string') error(`http.cookie.secret must be a string, got ${kindOf(cookie)}`);
  else if (!cookie) weak('http.cookie.secret is not set: signed cookies and sessions cannot be trusted');
  else if (cookie === AUTHN_PUBLIC_COOKIE_SECRET) weak('http.cookie.secret is the public default @spinajs/http ships; set your own');

  const mfaKey = config.get<unknown>('authn.mfa.encryptionKey');
  if (!absent(mfaKey) && !isObject(mfaKey)) error(`authn.mfa.encryptionKey must be a { secret } object, got ${kindOf(mfaKey)}`);
  else {
    const secret = mfaKey?.secret;
    if (!absent(secret) && typeof secret !== 'string') error(`authn.mfa.encryptionKey.secret must be a string or null, got ${kindOf(secret)}`);
    else if (!secret) {
      let storing: readonly string[] = [];
      try {
        storing = await steps();
      } catch (e) {
        weak(`authn.mfa.encryptionKey.secret is not set and the MFA steps cannot be resolved to tell whether they store secrets: ${safeMessage(e, 'resolving the MFA steps')}`);
      }
      if (storing.length > 0) weak(`authn.mfa.encryptionKey.secret is not set, but the MFA step(s) ${storing.map(q).join(', ')} store secrets`);
    }
  }

  pepperFindings(config.get<unknown>('authn.local.pepper'), error, weak);
  return out;
}

function pepperFindings(pepper: unknown, error: (m: string) => void, weak: (m: string) => void): void {
  if (absent(pepper)) return;
  if (!isObject(pepper)) {
    error(`authn.local.pepper must be a { secret, version } object, got ${kindOf(pepper)}`);
    return;
  }
  const { secret, version, previous } = pepper;
  if (!absent(version) && !isVersion(version)) error('authn.local.pepper.version must be an integer >= 1');
  const current = isVersion(version) ? version : 1;
  if (!absent(secret) && typeof secret !== 'string') error(`authn.local.pepper.secret must be a string or null, got ${kindOf(secret)}`);
  // null turns the pepper off; an empty string is a pepper that adds nothing.
  else if (secret === '') weak('authn.local.pepper.secret is empty; set a value, or null to turn the pepper off');

  if (absent(previous)) return;
  if (!Array.isArray(previous)) {
    error(`authn.local.pepper.previous must be a list of { secret, version }, got ${kindOf(previous)}`);
    return;
  }
  const malformed: number[] = [];
  const seen = new Set<number>();
  let clash = false;
  previous.forEach((p: unknown, i) => {
    // Unlike the current pepper, an old one cannot be off: the schema requires a non-empty secret in every env.
    if (!isObject(p) || typeof p.secret !== 'string' || p.secret === '' || !isVersion(p.version)) {
      malformed.push(i);
      return;
    }
    if (p.version === current || seen.has(p.version)) clash = true;
    seen.add(p.version);
  });
  if (malformed.length > 0) error(`authn.local.pepper.previous entries ${malformed.join(', ')} must be { secret, version } with a non-empty string secret and an integer version >= 1`);
  if (clash) error(`authn.local.pepper.previous: each version must differ from the others and from authn.local.pepper.version (${current})`);
}

/**
 * Fails boot with every error of authnSecretFindings, after passing its warnings to `warn`. The steps are those of the
 * container's MfaStepRegistry.
 */
export async function checkAuthnSecrets(config: AuthnConfigSource, container: IContainer, warn: (message: string) => void): Promise<void> {
  const findings = await authnSecretFindings(config, () => secretStoringSteps(container));
  for (const f of findings) if (f.level === 'warning') warn(f.message);
  const errors = findings.filter((f) => f.level === 'error');
  if (errors.length > 0) throw new InvalidOption(`authn boot refused: ${errors.map((f) => f.message).join('; ')}`);
}
