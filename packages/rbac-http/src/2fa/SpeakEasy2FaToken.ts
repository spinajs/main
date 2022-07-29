import { Injectable } from '@spinajs/di';
import { TwoFactorAuthProvider } from '../interfaces';
import * as speakeasy from 'speakeasy';
import { User } from '@spinajs/rbac';

@Injectable(TwoFactorAuthProvider)
export class SpeakEasy2FaToken extends TwoFactorAuthProvider {
  public execute(user: User): Promise<void> {
    // empty, speakasy works offline eg. google authenticator
    return Promise.resolve();
  }
  public verifyToken(token: string, user: User): Promise<boolean> {
    throw new Error('Method not implemented.');
  }
  public initialize(user: User): Promise<unknown> {
    throw new Error('Method not implemented.');
  }
  public isEnabled(user: User): Promise<boolean> {
    throw new Error('Method not implemented.');
  }
  public isInitialized(user: User): Promise<boolean> {
    throw new Error('Method not implemented.');
  }
}
