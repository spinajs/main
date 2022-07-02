import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import './auth';
import './password';
import './session';
import { AccessControl } from 'accesscontrol';

export * from './interfaces';
export * from './auth';
export * from './password';
export * from './session';
export * from './models/User';
export * from './models/UserMetadata';
export { AccessControl } from 'accesscontrol';

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    const ac = new AccessControl();
    DI.register(ac).as('AccessControl');

    ac.grant('admin.users').createAny('users').updateAny('users').deleteAny('users').readAny('users');
    ac.grant('user').updateOwn('users', ['Email', 'Login', 'Password', 'NiceName']);
    ac.grant('admin').extend('admin.users');
  }
}
