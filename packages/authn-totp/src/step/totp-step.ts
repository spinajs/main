import * as OTPAuth from 'otpauth';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation, UnexpectedServerError } from '@spinajs/exceptions';
import { IdentityStore, MfaStep } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { mfaKeyRingFrom } from '../cipher/key-ring.js';
import type { MfaEncryptionKeyOptions, MfaKeyRing } from '../cipher/key-ring.js';
import { MfaSecretStore } from '../store/store.js';
import type { MfaRecord } from '../store/store.js';
import { identityKey } from '../store/identity.js';
import { registered } from '../support/registered.js';
import { TotpAlreadyEnrolled, TotpEnrolmentChanged, TotpInvalidCode, TotpNotBegun, TotpNotEnrolled, TotpRecoveryCodesNotIssued } from './errors.js';
import { totpOptions } from './options.js';
import { newRecoveryCodeSet, normaliseRecoveryCode, showRecoveryCode } from './recovery-codes.js';
import type { TotpOptions, TotpOptionsInput } from './options.js';

/** RFC 4226 recommends at least 160 bits. */
const SECRET_BYTES = 20;

/** Left out, a dependency is resolved from DI on first use; `identities: null` means none. */
export interface TotpMfaStepDeps {
  readonly store?: MfaSecretStore;
  readonly keys?: MfaKeyRing;
  readonly options?: TotpOptions;
  readonly identities?: IdentityStore | null;
}

interface Resolved {
  readonly store: MfaSecretStore;
  readonly keys: MfaKeyRing;
  readonly options: TotpOptions;
  readonly identities: IdentityStore | null;
}

/**
 * TOTP (RFC 6238) on `otpauth`. Secrets are stored AES-256-GCM encrypted with their key id (SR-09); each accepted
 * code spends its time step and every older one (A10, SR-15).
 */
@Injectable(MfaStep)
export class TotpMfaStep extends MfaStep {
  readonly name = 'totp';
  readonly storesSecrets = true;

  private resolved: Resolved | null = null;
  private readonly options: TotpOptions | undefined;

  constructor(private readonly deps: TotpMfaStepDeps = {}) {
    super();
    this.options = deps.options && totpOptions(deps.options);
  }

  async enrolled(id: IdentityRef): Promise<boolean> {
    const { store } = await this.resolve();
    return !!(await store.get(id, this.name))?.confirmedAt;
  }

  /** For admin resets and diagnostics; never exposes the secret. */
  async enrolment(id: IdentityRef): Promise<'none' | 'pending' | 'confirmed'> {
    const { store } = await this.resolve();
    const row = await store.get(id, this.name);
    return !row ? 'none' : row.confirmedAt ? 'confirmed' : 'pending';
  }

  /** Throws `TotpAlreadyEnrolled` when the identity is enrolled. */
  async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    identityKey(id);
    const { store, keys, options } = await this.resolve();
    const secret = new OTPAuth.Secret({ size: SECRET_BYTES }).base32;
    const { secretEnc, keyId } = keys.encrypt(id, this.name, secret);
    const totp = this.totp(secret, options, await this.label(id));
    // Only the conditional put protects a confirmation that completes meanwhile; this check just fails early.
    if ((await store.get(id, this.name))?.confirmedAt || !(await store.put(id, this.name, secretEnc, keyId))) {
      throw new TotpAlreadyEnrolled('TOTP is already enrolled for this identity; disable it first');
    }
    return { provisioning: totp.toString() };
  }

  /**
   * Throws `TotpNotBegun` without a pending row, `TotpInvalidCode` for a wrong or spent code, `TotpAlreadyEnrolled`
   * when the enrolment is (or just got) confirmed, `TotpRecoveryCodesNotIssued` when this call confirmed it but storing
   * the codes failed, and `TotpEnrolmentChanged` when a begin replaced the secret.
   */
  async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    const { store } = await this.resolve();
    const row = await store.get(id, this.name);
    if (!row) {
      throw new TotpNotBegun('no pending TOTP enrolment for this identity');
    }
    if (row.confirmedAt) {
      throw new TotpAlreadyEnrolled('TOTP is already confirmed for this identity');
    }
    const timeStep = await this.match(id, row, response);
    if (timeStep === null || !(await store.acceptStep(id, this.name, timeStep))) {
      throw new TotpInvalidCode('the TOTP code does not match');
    }
    // Fails when a begin replaced the secret this code proves, or another confirmation won; only the winner issues codes.
    if (!(await store.confirm(id, this.name, undefined, row.secretEnc))) {
      const now = await store.get(id, this.name);
      if (now?.confirmedAt && now.secretEnc === row.secretEnc) {
        throw new TotpAlreadyEnrolled('TOTP is already confirmed; regenerate the recovery codes if you did not see them');
      }
      throw new TotpEnrolmentChanged('the TOTP enrolment changed during confirmation; begin again');
    }
    let codes: readonly string[];
    try {
      codes = await this.issueRecoveryCodes(id);
    } catch (err) {
      throw new TotpRecoveryCodesNotIssued('TOTP is confirmed but the recovery codes could not be issued; regenerate them', err);
    }
    return codes.length > 0 ? { recoveryCodes: codes } : {};
  }

  async verify(id: IdentityRef, response: string): Promise<boolean> {
    const { store, options } = await this.resolve();
    if (this.normalise(response, options) === null) {
      return false;
    }
    const row = await store.get(id, this.name);
    if (!row?.confirmedAt) {
      return false;
    }
    const timeStep = await this.match(id, row, response);
    return timeStep !== null && (await store.acceptStep(id, this.name, timeStep));
  }

  /** Takes a recovery code only (D8); single use. */
  async verifyRecovery(id: IdentityRef, code: string): Promise<boolean> {
    const { store } = await this.resolve();
    const normalised = normaliseRecoveryCode(code);
    if (normalised === null || !(await this.enrolled(id))) {
      return false;
    }
    return store.redeemRecoveryCode(id, normalised);
  }

  /** Voids the old set; the new codes are returned once. */
  async regenerateRecoveryCodes(id: IdentityRef): Promise<readonly string[]> {
    if (!(await this.enrolled(id))) {
      throw new TotpNotEnrolled('no confirmed TOTP enrolment for this identity');
    }
    return this.issueRecoveryCodes(id);
  }

  async disable(id: IdentityRef): Promise<void> {
    const { store } = await this.resolve();
    await store.remove(id, this.name);
    await store.removeRecoveryCodes(id);
  }

  /** Replaces the identity's codes with a fresh set and returns it in the shown form. */
  private async issueRecoveryCodes(id: IdentityRef): Promise<readonly string[]> {
    const { store, options } = await this.resolve();
    const codes = newRecoveryCodeSet(options.recoveryCodes);
    await store.replaceRecoveryCodes(id, codes);
    return Object.freeze(codes.map(showRecoveryCode));
  }

  /** The time step the response belongs to, or null when it matches none inside the window. */
  private async match(id: IdentityRef, row: MfaRecord, response: string): Promise<number | null> {
    const { keys, options } = await this.resolve();
    const token = this.normalise(response, options);
    if (token === null) {
      return null;
    }
    let secret: string;
    try {
      secret = keys.decrypt(id, this.name, row.secretEnc, row.keyId);
    } catch {
      // A wrong key or a damaged row is a server fault, never a wrong code.
      throw new UnexpectedServerError(`TotpMfaStep: the stored TOTP secret does not decrypt (key id ${JSON.stringify(row.keyId)})`);
    }
    const totp = this.totp(secret, options);
    const timestamp = Date.now();
    const delta = totp.validate({ token, timestamp, window: options.window });
    return delta === null ? null : OTPAuth.TOTP.counter({ period: options.period, timestamp }) + delta;
  }

  /** Exactly `digits` ASCII digits once whitespace is gone, so a recovery code never reaches the store. */
  private normalise(response: unknown, options: TotpOptions): string | null {
    if (typeof response !== 'string') {
      return null;
    }
    const token = response.replace(/\s+/g, '');
    return token.length === options.digits && /^[0-9]+$/.test(token) ? token : null;
  }

  private totp(secret: string, options: TotpOptions, label = ''): OTPAuth.TOTP {
    return new OTPAuth.TOTP({ issuer: options.issuer, label, algorithm: options.algorithm, digits: options.digits, period: options.period, secret: OTPAuth.Secret.fromBase32(secret) });
  }

  private async label(id: IdentityRef): Promise<string> {
    const { identities } = await this.resolve();
    const shown = identities ? await identities.display(id) : null;
    return shown?.email || shown?.name || id.id;
  }

  private async resolve(): Promise<Resolved> {
    if (this.resolved) {
      return this.resolved;
    }
    const config = DI.get(Configuration);
    const store = this.deps.store ?? (registered(MfaSecretStore) ? await DI.resolve(MfaSecretStore) : null);
    if (!store) {
      throw new InvalidOperation('TotpMfaStep: no MfaSecretStore is registered; import "@spinajs/authn-totp/db" (DbMfaSecretStore) or register another MfaSecretStore');
    }
    const keys = this.deps.keys ?? mfaKeyRingFrom(config?.get<MfaEncryptionKeyOptions>(['authn', 'mfa', 'encryptionKey']) as MfaEncryptionKeyOptions);
    const options = this.options ?? totpOptions(config?.get<TotpOptionsInput>(['authn', 'mfa', 'totp'], {}) ?? {});
    const identities = this.deps.identities !== undefined ? this.deps.identities : registered(IdentityStore) ? await DI.resolve(IdentityStore) : null;
    this.resolved = { store, keys, options, identities };
    return this.resolved;
  }
}
