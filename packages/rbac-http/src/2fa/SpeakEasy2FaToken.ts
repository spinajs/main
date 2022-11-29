import { Injectable } from '@spinajs/di';
import { TwoFactorAuthProvider } from '../interfaces';
import * as speakeasy from 'speakeasy';
import { User, UserMetadata } from '@spinajs/rbac';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';

@Injectable(TwoFactorAuthProvider)
export class SpeakEasy2FaToken extends TwoFactorAuthProvider {
  @Config('rbac.speakeasy')
  protected Config: any;

  @Logger('SPEAKEASY_2FA_TOKEN')
  protected Log: Log;

  constructor() {
    super();
  }

  public execute(_: User): Promise<void> {
    // empty, speakasy works offline eg. google authenticator
    // we dont send any email or sms
    return Promise.resolve();
  }
  public async verifyToken(token: string, user: User): Promise<boolean> {
    const meta = user.Metadata.find((x) => x.Key === '2fa_speakeasy_token');

    if (!meta || meta.Value === '') {
      this.Log.trace(`Cannot verify 2fa token, no 2fa token for user ${user.Id}`);

      return false;
    }

    const verified = speakeasy.totp.verify({
      secret: meta.Value,
      encoding: 'base32',
      token,
      window: 5,
    });

    return verified;
  }

  public async initialize(user: User): Promise<any> {
    const secret = speakeasy.generateSecret(this.Config);
    await user.Metadata.add(new UserMetadata({ Value: secret.base32, Key: '2fa_speakeasy_token' }));
    return secret.base32;
  }

  public async isEnabled(user: User): Promise<boolean> {
    const meta = user.Metadata.find((x) => x.Key === '2fa_enabled');
    return meta ? meta.asBoolean() : false;
  }

  public async isInitialized(user: User): Promise<boolean> {
    const meta = user.Metadata.find((x) => x.Key === '2fa_speakeasy_token');
    return meta ? meta.Value !== '' : false;
  }
}
