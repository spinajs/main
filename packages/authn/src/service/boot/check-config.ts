import type { IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration, resolveNamedService } from '@spinajs/configuration';
import type { IConfigurationSchema } from '@spinajs/configuration';

import { AuthenticationStrategy } from '../../contracts/strategy.js';
import { MfaPolicy } from '../../contracts/mfa.js';
import { AuthnThrottle } from '../../contracts/throttle.js';
import { MfaEnrolments } from '../../flow/mfa-enrolments.js';
import { AUTHN_THROTTLE_SERVICE } from '../../throttle/select.js';
import { MFA_POLICY_SERVICE } from '../../flow/select-policy.js';
import { AUTHN_CONFIGURATION_SCHEMA } from '../../schemas/authn.configuration.js';
import type { StrategyEntry } from '../../registry/strategy-registry.js';
import { q } from '../../support/format.js';
import { AUTHN_ENV_FALLBACK_WARNING, authnEnvFellBack } from './env.js';
import type { AuthnConfigSource } from './env.js';
import { authnSecretFindings, safeMessage, secretStoringSteps } from './secrets.js';
import type { AuthnConfigFinding } from './secrets.js';

const set = (v: unknown): boolean => v !== undefined && v !== null;

// TODO: checking manualy config entries should be removes
// * anything can be checked with schema / json schema shoul be checked
// * if missing DI functions checks - extend json schema validation with DI  - extend validator package if needed

function strategyFindings(container: IContainer, config: AuthnConfigSource): AuthnConfigFinding[] {
  const listed = config.get<unknown>('authn.strategies') ?? [];
  // A list the schema refuses is reported as a schema finding; there is nothing to check here.
  if (!Array.isArray(listed)) return [];
  const entries = listed as StrategyEntry[];
  if (entries.length === 0) return [{ topic: 'strategies', level: 'warning', message: 'authn.strategies lists no strategy: nothing can authenticate' }];
  const registered = container.getRegisteredNames(AuthenticationStrategy);
  const missing = entries.filter((e) => !registered.includes(e.service));
  if (missing.length === 0) return [];
  const names = missing.map((e) => `${q(e.name)} (service ${q(e.service)})`).join(', ');
  return [{ topic: 'strategies', level: 'error', message: `authn.strategies: no AuthenticationStrategy is registered for ${names}; install the package that provides it` }];
}

// What boot refuses: a throttle that cannot be selected, or what the selected one refuses.
async function throttleFindings(container: IContainer, config: AuthnConfigSource): Promise<AuthnConfigFinding[]> {
  let throttle: AuthnThrottle;
  try {
    throttle = await resolveNamedService(container, 'authn.throttle.service', AuthnThrottle, AUTHN_THROTTLE_SERVICE);
  } catch (e) {
    return [{ topic: 'throttle', level: 'error', message: safeMessage(e, 'selecting the throttle') }];
  }
  try {
    await throttle.checkConfiguration?.(config);
    return [];
  } catch (e) {
    return [{ topic: 'throttle', level: 'error', message: safeMessage(e, 'checking the throttle configuration') }];
  }
}

/**
 * Confirmed steps of any MfaEnrolments source that authn.mfa.steps does not list: DefaultMfaPolicy refuses the password
 * logins of their users; another authn.mfa.policy.service decides for itself. Names steps only, never an identity.
 */
async function enrolmentFindings(container: IContainer, config: AuthnConfigSource): Promise<AuthnConfigFinding[]> {
  const entries = config.get<unknown>('authn.mfa.steps');
  const listed = new Set(Array.isArray(entries) ? (entries as { name?: unknown }[]).map((e) => e?.name) : []);
  let sources: readonly MfaEnrolments[];
  try {
    sources = await container.resolve(Array.chainOf(MfaEnrolments));
  } catch (e) {
    return [{ topic: 'mfa', level: 'error', message: safeMessage(e, 'resolving the MFA enrolment sources') }];
  }
  const out: AuthnConfigFinding[] = [];
  const unlisted = new Set<string>();
  for (const source of sources) {
    try {
      for (const name of await source.stepNames()) if (!listed.has(name)) unlisted.add(name);
    } catch (e) {
      out.push({ topic: 'mfa', level: 'error', message: `${safeMessage(e, `reading the enrolled MFA steps from ${source.constructor?.name ?? 'an MfaEnrolments source'}`)}; the password logins it would be asked about are refused while it fails` });
    }
  }
  if (unlisted.size > 0) {
    const names = [...unlisted].map(q).join(', ');
    const policy = config.get<unknown>('authn.mfa.policy.service');
    const effect =
      policy === undefined || policy === 'DefaultMfaPolicy'
        ? 'their password logins are refused until each is listed'
        : `DefaultMfaPolicy refuses their password logins, but authn.mfa.policy.service names ${q(String(policy))}, which decides; list each step`;
    out.push({ topic: 'mfa', level: 'error', message: `users are enrolled in ${unlisted.size} MFA step(s) authn.mfa.steps does not list (${names}): ${effect}, e.g. for totp install @spinajs/authn-totp and list { name: 'totp', service: 'TotpMfaStep' }` });
  }
  return out;
}

const schemaFindings = (e: InvalidConfiguration): AuthnConfigFinding[] => e.violations.map((v) => ({ topic: 'schema', level: 'error', message: `${v.path} ${v.message}` }));

/** The authn schema and the authn.* fragments registered in the lineage of `container` by the authn packages loaded. */
function authnSchemas(container: IContainer): IConfigurationSchema[] {
  type Schema = IConfigurationSchema & { $id?: string };
  const found: Schema[] = [AUTHN_CONFIGURATION_SCHEMA];
  for (let c: IContainer | undefined = container; c; c = c.Parent) {
    for (const s of (c.Cache.get('__configurationSchema__', false) ?? []) as Schema[]) {
      if (s.$configurationModule.startsWith('authn.') && !found.some((f) => f === s || f.$id === s.$id)) found.push(s);
    }
  }
  return found;
}

/**
 * authn:check-config: what the configuration of `container` gets wrong, by topic. It reports instead of throwing,
 * and covers what boot refuses (secrets, the throttle's checkConfiguration) and what boot accepts but an operator
 * should fix (no strategy, no proxy setting, an empty CORS list, an env that fell back to development, users enrolled in
 * an MFA step authn.mfa.steps does not list). Only this check asks the MfaEnrolments sources: with authn-orm loaded it
 * opens the authn store (the app database) to look for enrolled MFA steps.
 */
export async function checkAuthnConfig(container: IContainer): Promise<AuthnConfigFinding[]> {
  let config: Configuration;
  try {
    config = (await container.resolve(Configuration)) as Configuration;
  } catch (e) {
    // A configuration the schema refuses never resolves; report each violation (path and rule, never a value).
    if (e instanceof InvalidConfiguration) return schemaFindings(e);
    throw e;
  }
  // In a CLI process the root Configuration resolves before the authn packages are imported, so their schemas were never
  // applied, or only logged what they refused.
  if (config instanceof FrameworkConfiguration) {
    const refused: AuthnConfigFinding[] = [];
    for (const schema of authnSchemas(container)) {
      try {
        config.validateModule(schema);
      } catch (e) {
        if (!(e instanceof InvalidConfiguration)) throw e;
        refused.push(...schemaFindings(e));
      }
    }
    if (refused.length > 0) return refused;
  }
  const out: AuthnConfigFinding[] = [];

  if (authnEnvFellBack(config)) out.push({ topic: 'env', level: 'warning', message: AUTHN_ENV_FALLBACK_WARNING });

  out.push(...strategyFindings(container, config));

  let policy: MfaPolicy | undefined;
  try {
    policy = await resolveNamedService(container, 'authn.mfa.policy.service', MfaPolicy, MFA_POLICY_SERVICE);
  } catch (e) {
    out.push({ topic: 'mfa', level: 'error', message: safeMessage(e, 'resolving the MFA policy') });
  }
  out.push(...(await authnSecretFindings(config, async () => (policy ? secretStoringSteps(await policy.steps()) : []))));

  out.push(...(await throttleFindings(container, config)));

  out.push(...(await enrolmentFindings(container, config)));

  if (!set(config.get('authn.http.trustProxy')) && !set(config.get('http.trustProxy'))) {
    out.push({ topic: 'proxy', level: 'warning', message: 'Neither authn.http.trustProxy nor http.trustProxy is set: behind a proxy every client has the proxy address, so per-IP throttling and audit see one client (0 says there is no proxy)' });
  }

  // Without http.cors (any falsy value), @spinajs/http installs no CORS middleware: browsers keep the same-origin rule.
  const cors = config.get<unknown>('http.cors');
  if (cors) {
    const origins = (cors as { origins?: unknown }).origins;
    if (origins !== undefined && origins !== null && !Array.isArray(origins)) {
      out.push({ topic: 'cors', level: 'warning', message: 'http.cors.origins is not a list: @spinajs/http refuses to start; list the origins your browser clients use' });
    } else if (!Array.isArray(origins) || origins.length === 0) {
      out.push({ topic: 'cors', level: 'warning', message: 'http.cors.origins is empty or not set: no cross-origin request is allowed (A31); list the origins your browser clients use' });
    }
  }

  return out;
}
