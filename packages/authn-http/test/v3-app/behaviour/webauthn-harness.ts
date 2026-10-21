import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { PasskeyService } from '@spinajs/authn/contracts';
import type { HttpRoutes, WebAuthnPort } from '@spinajs/authn-testing';

import { STRATEGIES } from './harness.js';
import type { HarnessLane } from './harness.js';

/**
 * The A33 lane over the N8a harness: authn-webauthn's PasskeyStrategy, WebAuthnPasskeyService and in-memory stores
 * behind AuthnPasskeyController. The package is imported on the first case, so the suites before this one see no
 * passkey service; its registrations then stay for the rest of the process, with the passkey routes off wherever
 * authn.strategies lists no passkey strategy.
 */

export const PASSKEY_ROUTES: Partial<HttpRoutes> = {
  passkeyChallenge: () => ({ method: 'POST', path: '/auth/passkeys/challenge' }),
  passkeyLogin: (body) => ({ method: 'POST', path: '/auth/passkeys/login', body }),
  passkeyOptions: (o) => ({ method: 'POST', path: '/user/passkeys/options', body: { ...o } }),
  passkeyRegister: (body) => ({ method: 'POST', path: '/user/passkeys', body }),
  passkeyList: () => ({ method: 'GET', path: '/user/passkeys' }),
  passkeyDelete: (id) => ({ method: 'DELETE', path: `/user/passkeys/${encodeURIComponent(id)}` }),
};

/** The relying party of every case; the kit's authenticator signs for this origin, whatever port the app listens on. */
export const LANE_RP: WebAuthnPort = Object.freeze({ rpId: 'app.example.test', origin: 'https://app.example.test' });

const LANE_CONFIG = { rpId: LANE_RP.rpId, rpName: 'SpinaJS lane', origins: [LANE_RP.origin], userVerification: 'preferred', challengeTtlSeconds: 300, recoveryCodes: 10 };

type WebAuthnModule = typeof import('@spinajs/authn-webauthn');

let webauthn: WebAuthnModule | undefined;
let saved: { value: unknown } | undefined;

const config = (): Configuration => DI.get(Configuration)!;

async function load(): Promise<WebAuthnModule> {
  if (webauthn) return webauthn;
  webauthn = await import('@spinajs/authn-webauthn');
  DI.register(webauthn.MemoryWebAuthnCredentialStore).as(webauthn.WebAuthnCredentialStore);
  DI.register(webauthn.MemoryWebAuthnChallengeStore).as(webauthn.WebAuthnChallengeStore);
  DI.register(webauthn.MemoryWebAuthnRecoveryCodeStore).as(webauthn.WebAuthnRecoveryCodeStore);
  return webauthn;
}

/** Fresh stores and services per case: each one holds the stores, the config and the AuthnAudit it was built with. */
function uncache(w: WebAuthnModule): void {
  const types = [w.MemoryWebAuthnCredentialStore, w.MemoryWebAuthnChallengeStore, w.MemoryWebAuthnRecoveryCodeStore, w.WebAuthnCredentialStore, w.WebAuthnChallengeStore, w.WebAuthnRecoveryCodeStore, w.WebAuthnPasskeyService, w.PasskeyStrategy, w.WebAuthnMfaStep];
  for (const type of [...types, PasskeyService]) DI.uncache(type as unknown as Class<unknown>);
}

function restoreConfig(): void {
  if (!saved) return;
  if (saved.value === undefined) delete config().get<Record<string, unknown>>('authn').webauthn;
  else config().set('authn.webauthn', saved.value);
  saved = undefined;
}

export const webauthnLane: HarnessLane = {
  strategies: [...STRATEGIES, { name: 'passkey', service: 'PasskeyStrategy' }],
  supportedConfig: [],
  routes: PASSKEY_ROUTES,
  async open() {
    const w = await load();
    uncache(w);
    saved = { value: config().get('authn.webauthn') };
    config().set('authn.webauthn', { ...LANE_CONFIG, origins: [...LANE_CONFIG.origins] });
  },
  async ports() {
    return { webauthn: LANE_RP };
  },
  async close() {
    restoreConfig();
    if (webauthn) uncache(webauthn);
  },
};
