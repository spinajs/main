import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { SimpleDbAuthProvider } from './auth';
import { PasswordProvider, AuthProvider, SessionProvider } from './interfaces';
import { BasicPasswordProvider } from './password';
import { MemorySessionProvider } from './session';
import { AccessControl } from 'accesscontrol';

export * from './interfaces';
export * from './auth';
export * from './password';
export * from './session';
export * from './models/User';
export * from './models/UserMetadata';

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(MemorySessionProvider).as(SessionProvider);

    const ac = new AccessControl();
    DI.register(ac).as('AccessControl');

    ac.grant('admin.users').createAny('users').updateAny('users').deleteAny('users').readAny('users');
    ac.grant('user').updateOwn('users', ['Email', 'Login', 'Password', 'NiceName']);
    ac.grant('admin').extend('admin.users');
  }
}
