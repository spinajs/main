import { Bootstrapper, Injectable } from '@spinajs/di';
import { UserMetadataBase } from '@spinajs/rbac';
import { TWO_FA_METATADATA_KEYS } from './2fa/Default2FaToken.js';

export * from './controllers/LoginController.js';
export * from './controllers/ActiveRoleController.js';
export * from './controllers/ImpersonationController.js';
export * from './controllers/UserController.js';

export * from './logout.js';
export * from './handlers/ImpersonationLogoutHandler.js';
export * from './handlers/DefaultLogoutHandler.js';
export * from './controllers/UserMetadataController.js';
export * from "./controllers/TwoFactorAuthController.js";
export * from "./controllers/TwoFactorAuthUserController.js";
export * from "./controllers/PasswordResetController.js";

export * from "./cli/EnableUser2Fa.js";
export * from "./2fa/Default2FaToken.js";

export * from './actions/2fa.js';

export * from './services/SessionCookies.js';
export * from './services/grants.js';
export * from './services/ImpersonationService.js';
export * from './services/UserMetadataService.js';

export * from './policies/2FaPolicy.js';

// Emitted on the 2FA lifecycle and routed by name in this package's config —
// consumers need the classes themselves to subscribe by type.
export * from './events/User2FaEnabled.js';
export * from './events/User2FaDisabled.js';
export * from './events/User2FaPassed.js';
export * from './events/User2FaReset.js';

export * from './dto/confirm-password-dto.js';
export * from './dto/impersonate-dto.js';
export * from './dto/metadata-dto.js';
export * from './dto/password-dto.js';
export * from './dto/password-reset-dto.js';
export * from './dto/switchRole-dto.js';
export * from './dto/token-dto.js';
export * from './dto/userLogin-dto.js';


@Injectable(Bootstrapper)
export class RbacHttpUserBootstrapper extends Bootstrapper {
    public bootstrap(): void {
        UserMetadataBase._hiddenKeys = [
            ...UserMetadataBase._hiddenKeys,
            TWO_FA_METATADATA_KEYS.TOKEN,
            TWO_FA_METATADATA_KEYS.OTP
        ]
    }
}
