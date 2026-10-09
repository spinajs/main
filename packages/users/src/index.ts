import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';
import { EmailPasswordMailer } from '@spinajs/email';
import { PasswordMailer } from '@spinajs/authn-local';

import { USERS_ACCESS_CONFIGURATION_SCHEMA } from './authn/access-schema.js';

import './auth.js';
import './password.js';
import './session.js';
import './session-expiration.js';
import { User, USER_SECURITY_METADATA_KEYS } from './models/User.js';
import { UserMetadataBase } from './models/UserMetadata.js';
import { RBAC_USER_MODEL } from './model-token.js';

export * from './interfaces.js';
export * from './exceptions.js';
export * from './auth.js';
export * from './password.js';
export * from './session.js';
export * from './session-expiration.js';
export * from './models/User.js';
export * from './models/UserMetadata.js';
export * from './migrations/RBACInitial_2022_06_28_01_13_00.js';
export * from './migrations/RBACRegisteredAt_2026_07_28_00_00_00.js';
export * from './migrations/UsersPasswordSetAt_2026_10_04_00_00_00.js';
export * from './events/index.js';
export * from './actions.js';
export * from './profile.js';
export * from './model-token.js';
export * from './cli/RbacCliCommand.js';
export * from './principal/index.js';
export * from './self-relation.js';
export * from './metadata-owner-relation.js';
export * from './user-resource-adapter.js';
export * from './default-roles-check.js';
export * from './identity/index.js';
export * from './authn/index.js';

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(USERS_ACCESS_CONFIGURATION_SCHEMA);

    /**
     * Credential-bearing metadata never leaves the server in a dehydrated user.
     * Seeded here rather than as the field initialiser so an application ( or
     * another package, eg. authn-totp adding its 2FA keys ) can append to
     * the list without having to restate this one. De-duplicated because tests
     * run bootstrappers repeatedly against a live static.
     */
    UserMetadataBase._hiddenKeys = [...new Set([...UserMetadataBase._hiddenKeys, ...USER_SECURITY_METADATA_KEYS])];

    // Default user model class. Guarded so an application's override survives any
    // registration order — the app always uses asValue(RBAC_USER_MODEL, true).
    if (!DI.RootContainer.Cache.has(RBAC_USER_MODEL)) {
      DI.register(User).asValue(RBAC_USER_MODEL);
    }

    // authn-local mails reset and invite secrets through a PasswordMailer and registers none (email does not depend
    // on it). Bootstrappers run after the application's imports, so a mailer it registered is seen here and kept.
    if (!DI.RootContainer.hasRegistered(PasswordMailer)) {
      DI.register(EmailPasswordMailer).as(PasswordMailer);
    }
  }
}
