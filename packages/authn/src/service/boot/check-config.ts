import type { IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';

import { AuthenticationStrategy } from '../../contracts/strategy.js';
import type { AuthnThrottle } from '../../contracts/throttle.js';
import { selectAuthnThrottle } from '../../throttle/select.js';
import { AUTHN_CONFIGURATION_SCHEMA } from '../../schemas/authn.configuration.js';
import { nearestRegistration, q } from '../../registry/named.js';
import type { NamedEntry } from '../../registry/named.js';
import { AUTHN_ENV_FALLBACK_WARNING, authnEnvFellBack } from './env.js';
import type { AuthnConfigSource } from './env.js';
import { authnLegacyKeysText, findAuthnLegacyKeys, rejectsAuthnLegacyKeys } from './legacy-keys.js';
import { authnSecretFindings, safeMessage, secretStoringSteps } from './secrets.js';
import type { AuthnConfigFinding } from './secrets.js';

const set = (v: unknown): boolean => v !== undefined && v !== null;

function strategyFindings(container: IContainer, config: AuthnConfigSource): AuthnConfigFinding[] {
  const listed = config.get<unknown>('authn.strategies') ?? [];
  // A list the schema refuses is reported as a schema finding; there is nothing to check here.
  if (!Array.isArray(listed)) return [];
  const entries = listed as NamedEntry[];
  if (entries.length === 0) return [{ topic: 'strategies', level: 'warning', message: 'authn.strategies lists no strategy: nothing can authenticate' }];
  const missing = entries.filter((e) => !nearestRegistration(container, AuthenticationStrategy, e.service));
  if (missing.length === 0) return [];
  const names = missing.map((e) => `${q(e.name)} (service ${q(e.service)})`).join(', ');
  return [{ topic: 'strategies', level: 'error', message: `authn.strategies: no AuthenticationStrategy is registered for ${names}; install the package that provides it` }];
}

function legacyFindings(config: AuthnConfigSource): AuthnConfigFinding[] {
  try {
    const reject = rejectsAuthnLegacyKeys(config);
    const found = findAuthnLegacyKeys(config.get<unknown>('rbac'));
    return found.length === 0 ? [] : [{ topic: 'legacy', level: reject ? 'error' : 'warning', message: authnLegacyKeysText(found) }];
  } catch (e) {
    return [{ topic: 'legacy', level: 'error', message: safeMessage(e, 'reading authn.config and rbac') }];
  }
}

// What boot refuses: a throttle that cannot be selected, or what the selected one refuses.
async function throttleFindings(container: IContainer, config: AuthnConfigSource): Promise<AuthnConfigFinding[]> {
  let throttle: AuthnThrottle;
  try {
    throttle = await selectAuthnThrottle(container, config.get<string | undefined>('authn.throttle.service'));
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

const schemaFindings = (e: InvalidConfiguration): AuthnConfigFinding[] => e.violations.map((v) => ({ topic: 'schema', level: 'error', message: `${v.path} ${v.message}` }));

/**
 * authn:check-config: what the configuration of `container` gets wrong, by topic. It reports instead of throwing,
 * and covers what boot refuses (secrets, the throttle's checkConfiguration, legacy keys with rejectLegacyKeys) and what boot accepts but an operator
 * should fix (no strategy, no proxy setting, an empty CORS list, an env that fell back to development).
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
  // In a CLI process the root Configuration resolves before @spinajs/authn is imported, so the schema was never applied.
  if (config instanceof FrameworkConfiguration) {
    try {
      config.validateModule(AUTHN_CONFIGURATION_SCHEMA);
    } catch (e) {
      if (e instanceof InvalidConfiguration) return schemaFindings(e);
      throw e;
    }
  }
  const out: AuthnConfigFinding[] = [];

  if (authnEnvFellBack(config)) out.push({ topic: 'env', level: 'warning', message: AUTHN_ENV_FALLBACK_WARNING });

  out.push(...strategyFindings(container, config));

  out.push(
    ...(await authnSecretFindings(config, async () => {
      try {
        return await secretStoringSteps(container);
      } catch (e) {
        out.push({ topic: 'mfa', level: 'error', message: safeMessage(e, 'resolving the MFA steps') });
        return [];
      }
    })),
  );

  out.push(...(await throttleFindings(container, config)));

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

  out.push(...legacyFindings(config));
  return out;
}
