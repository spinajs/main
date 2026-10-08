import 'mocha';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { InvalidOption } from '@spinajs/exceptions';

import authnTotp from '../../src/config/authn-totp.js';
import { MemoryMfaSecretStore } from '../../src/store/index.js';
import { TotpMfaStep } from '../../src/step/index.js';
import { TotpService } from '../../src/service/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';
import { TOTP_DEFAULTS } from './support/totp-defaults.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const bad = (authn: Record<string, unknown>) => violationsOf(SCHEMAS, { authn });
const KEY = randomBytes(32).toString('hex');
const OLD = randomBytes(32).toString('base64url');

describe('authn.mfa.totp, authn.mfa.encryptionKey and authn.freshAuth through the schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills authn.mfa.totp and authn.freshAuth', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.mfa.totp')).to.deep.eq({ ...TOTP_DEFAULTS });
      expect(configuration.get('authn.freshAuth.maxAgeSeconds')).to.eq(300);
    });

    it('equals the shipped package config', () => {
      expect(authnTotp.authn.mfa.totp).to.deep.eq({ ...TOTP_DEFAULTS });
    });

    it('keeps a configured value and fills the rest', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { mfa: { totp: { issuer: 'Acme', digits: 8 } } } });
      expect(configuration.get('authn.mfa.totp')).to.deep.eq({ ...TOTP_DEFAULTS, issuer: 'Acme', digits: 8 });
    });
  });

  describe('violations', () => {
    it('names the bad totp key', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ issuer: '' }, 'authn.mfa.totp.issuer'],
        [{ algorithm: 'sha-256' }, 'authn.mfa.totp.algorithm'],
        [{ algorithm: 'MD5' }, 'authn.mfa.totp.algorithm'],
        [{ digits: 5 }, 'authn.mfa.totp.digits'],
        [{ digits: 11 }, 'authn.mfa.totp.digits'],
        [{ period: 0 }, 'authn.mfa.totp.period'],
        [{ period: 301 }, 'authn.mfa.totp.period'],
        [{ window: -1 }, 'authn.mfa.totp.window'],
        [{ window: 11 }, 'authn.mfa.totp.window'],
        [{ recoveryCodes: -1 }, 'authn.mfa.totp.recoveryCodes'],
        [{ recoveryCodes: 101 }, 'authn.mfa.totp.recoveryCodes'],
        [{ period: 30.5 }, 'authn.mfa.totp.period'],
      ];
      for (const [totp, path] of cases) expect(await bad({ mfa: { totp } }), JSON.stringify(totp)).to.include(path);
    });

    it('accepts the limits and the three algorithms', async () => {
      for (const totp of [{ digits: 6, period: 1, window: 0, recoveryCodes: 0 }, { digits: 10, period: 300, window: 10, recoveryCodes: 100 }, { algorithm: 'SHA256' }, { algorithm: 'SHA512' }]) {
        expect(await bad({ mfa: { totp } }), JSON.stringify(totp)).to.deep.eq([]);
      }
    });

    it('names the bad encryption key, current or previous', async () => {
      expect(await bad({ mfa: { encryptionKey: { secret: 'short' } } })).to.include('authn.mfa.encryptionKey.secret');
      expect(await bad({ mfa: { encryptionKey: { secret: 'g'.repeat(64) } } })).to.include('authn.mfa.encryptionKey.secret');
      expect(await bad({ mfa: { encryptionKey: { secret: KEY, previous: [OLD, 'short'] } } })).to.include('authn.mfa.encryptionKey.previous.1');
      expect(await bad({ mfa: { encryptionKey: { secret: KEY, previous: OLD } } })).to.include('authn.mfa.encryptionKey.previous');
    });

    it('accepts a key as hex, base64 or base64url, and null', async () => {
      const bytes = randomBytes(32);
      for (const secret of [KEY, bytes.toString('base64'), bytes.toString('base64url'), null]) {
        expect(await bad({ mfa: { encryptionKey: { secret, previous: [OLD] } } }), String(secret)).to.deep.eq([]);
      }
    });

    it('names a freshAuth lifetime that is not a positive integer', async () => {
      for (const maxAgeSeconds of [0, -5, 1.5]) expect(await bad({ freshAuth: { maxAgeSeconds } }), String(maxAgeSeconds)).to.include('authn.freshAuth.maxAgeSeconds');
    });
  });

  describe('through @Config', () => {
    it('TotpMfaStep builds its options and key ring from the booted configuration', async () => {
      const { child } = await boot(SCHEMAS, { authn: { mfa: { totp: { issuer: 'Acme', digits: 8 }, encryptionKey: { secret: KEY } } } });
      const step = readingFrom(new TotpMfaStep({ store: new MemoryMfaSecretStore(), identities: null }), child);
      const { provisioning } = await step.beginEnrolment({ type: 'user', id: 'u1' });
      expect(new URL(provisioning).searchParams.get('issuer')).to.eq('Acme');
      expect(new URL(provisioning).searchParams.get('digits')).to.eq('8');
    });

    it('TotpMfaStep refuses to work when no encryption key is set', async () => {
      const { child } = await boot(SCHEMAS, {});
      const step = readingFrom(new TotpMfaStep({ store: new MemoryMfaSecretStore(), identities: null }), child);
      let error: unknown;
      try {
        await step.beginEnrolment({ type: 'user', id: 'u1' });
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(InvalidOption);
      expect(String(error)).to.contain('authn.mfa.encryptionKey.secret');
    });

    it('TotpService reads the fresh-auth lifetime and lets deps override it', async () => {
      const { child } = await boot(SCHEMAS, { authn: { freshAuth: { maxAgeSeconds: 120 } } });
      const service = readingFrom(new TotpService(), child) as unknown as { need(key: string): Promise<unknown> };
      expect(await service.need('maxAgeSeconds')).to.eq(120);
      const seam = readingFrom(new TotpService({ maxAgeSeconds: 5 }), child) as unknown as { need(key: string): Promise<unknown> };
      expect(await seam.need('maxAgeSeconds')).to.eq(5);
    });
  });
});
