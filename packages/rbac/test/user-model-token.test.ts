import 'reflect-metadata';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { User } from '../src/models/User.js';
import { RBAC_USER_MODEL, userModel } from '../src/model-token.js';
import { RbacBootstrapper } from '../src/index.js';

describe('RbacUserModel token', () => {
  afterEach(() => {
    // the token lives in the container value cache — drop it so cases stay independent
    DI.RootContainer.Cache.remove(RBAC_USER_MODEL);
  });

  it('falls back to the shipped User class when nothing is registered', () => {
    expect(userModel()).to.equal(User);
  });

  it('bootstrapper registers the default exactly once', () => {
    new RbacBootstrapper().bootstrap();
    expect(userModel()).to.equal(User);
  });

  it('application override wins whether it registers before or after the bootstrapper', () => {
    class AppUser extends User {}

    // app first, framework second — the guard must not clobber the app's class
    DI.register(AppUser).asValue(RBAC_USER_MODEL, true);
    new RbacBootstrapper().bootstrap();
    expect(userModel()).to.equal(AppUser);

    // framework first, app second — override=true replaces the default
    DI.RootContainer.Cache.remove(RBAC_USER_MODEL);
    new RbacBootstrapper().bootstrap();
    DI.register(AppUser).asValue(RBAC_USER_MODEL, true);
    expect(userModel()).to.equal(AppUser);
  });
});
