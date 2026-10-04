import { Bootstrapper, Injectable } from '@spinajs/di';
import { UserMetadataBase } from '@spinajs/users';
import { TWO_FA_METATADATA_KEYS } from './2fa/Default2FaToken.js';

export * from './interfaces.js';

export * from './cipher/index.js';
export * from './store/index.js';
export * from './step/index.js';
export * from './service/index.js';

export * from './cli/index.js';
export * from './cli/Generate2FaQrCode.js';
export * from './2fa/Default2FaToken.js';
export * from './2fa/otpUrl.js';

export * from './actions/2fa.js';

// Emitted on the 2FA lifecycle and routed by name in this package's config —
// consumers need the classes themselves to subscribe by type.
export * from './events/User2FaEnabled.js';
export * from './events/User2FaDisabled.js';
export * from './events/User2FaPassed.js';
export * from './events/User2FaReset.js';

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
