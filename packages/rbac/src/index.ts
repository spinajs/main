import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { SimpleDbAuthProvider } from './auth';
import { PasswordProvider, AuthProvider, SessionProvider } from './interfaces';
import { BasicPasswordProvider } from './password';
import { MemorySessionProvider } from './session';

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(MemorySessionProvider).as(SessionProvider);
  }
}
