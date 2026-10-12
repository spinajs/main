import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { MfaStepRegistry } from '../../flow/mfa-step-registry.js';
import { isSecretStoringMfaStep } from '../../flow/secret-storing-step.js';
import { AUTHN_PUBLIC_COOKIE_SECRET, authnAppEnv, isLenientAuthnEnv } from './env.js';
import type { AuthnConfigSource } from './env.js';

/** One finding of the boot checks and of authn:check-config. */
export interface AuthnConfigFinding {
  readonly topic: 'strategies' | 'secrets' | 'proxy' | 'cors' | 'env' | 'mfa' | 'schema' | 'throttle';
  readonly level: 'error' | 'warning';
  readonly message: string;
}

/** Names of the configured MFA steps that store secrets (D3). */
export type SecretStoringSteps = () => Promise<readonly string[]>;

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const absent = (v: unknown): v is undefined | null => v === undefined || v === null;

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
 * warning there; the shape of the settings is the schema's. Messages name keys, never values. `steps` is asked
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

  // The shape of both keys is the schema's; only what depends on the env and on the configured steps is checked here.
  if (!config.get<{ secret?: string | null } | undefined>('authn.mfa.encryptionKey')?.secret) {
    let storing: readonly string[] = [];
    try {
      storing = await steps();
    } catch (e) {
      weak(`authn.mfa.encryptionKey.secret is not set and the MFA steps cannot be resolved to tell whether they store secrets: ${safeMessage(e, 'resolving the MFA steps')}`);
    }
    if (storing.length > 0) weak(`authn.mfa.encryptionKey.secret is not set, but the MFA step(s) ${storing.map(q).join(', ')} store secrets`);
  }
  return out;
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
