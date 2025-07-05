import { Bootstrapper, Injectable } from '@spinajs/di';
import { UserMetadataBase } from '@spinajs/rbac';
import { TWO_FA_METATADATA_KEYS } from './2fa/Default2FaToken.js';

export * from './controllers/LoginController.js';
export * from './controllers/UserController.js';
export * from './controllers/UserMetadataController.js';
export * from "./controllers/TwoFactorAuthController.js";

export * from "./cli/EnableUser2Fa.js";
export * from "./2fa/Default2FaToken.js";


@Injectable(Bootstrapper)
export class RbacHttpUserBootstrapper extends Bootstrapper {
    public bootstrap(): void {
        UserMetadataBase._hiddenKeys = [
            ...UserMetadataBase._hiddenKeys,
            TWO_FA_METATADATA_KEYS.TOKEN,
            TWO_FA_METATADATA_KEYS.ENABLED,
            TWO_FA_METATADATA_KEYS.OTP
        ]
    }
}