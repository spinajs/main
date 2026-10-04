import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { AuthenticationStrategy } from '../../contracts/strategy.js';
import { nearestRegistration, q, readNamedEntries } from '../../registry/named.js';
import { AUTHN_ENV_FALLBACK_WARNING, authnEnvFellBack } from './env.js';
import type { AuthnConfigSource } from './env.js';
import { authnLegacyKeysText, findAuthnLegacyKeys, rejectsAuthnLegacyKeys } from './legacy-keys.js';
import { authnSecretFindings, safeMessage, secretStoringSteps } from './secrets.js';
import type { AuthnConfigFinding } from './secrets.js';

const set = (v: unknown): boolean => v !== undefined && v !== null;

function strategyFindings(container: IContainer, config: AuthnConfigSource): AuthnConfigFinding[] {
  let entries;
  try {
    entries = readNamedEntries(config.get<unknown>('authn.strategies'), 'authn.strategies', 'strategy');
  } catch (e) {
    return [{ topic: 'strategies', level: 'error', message: safeMessage(e, 'reading authn.strategies') }];
  }
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

/**
 * authn:check-config: what the configuration of `container` gets wrong, by topic. It reports instead of throwing,
 * and covers what boot refuses (secrets, legacy keys with rejectLegacyKeys) and what boot accepts but an operator
 * should fix (no strategy, no proxy setting, an empty CORS list, an env that fell back to development).
 */
export async function checkAuthnConfig(container: IContainer): Promise<AuthnConfigFinding[]> {
  const config = (await container.resolve(Configuration)) as Configuration;
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
