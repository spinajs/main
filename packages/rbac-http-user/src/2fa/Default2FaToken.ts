import { Injectable } from '@spinajs/di';
import { User } from '@spinajs/rbac';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { TwoFactorAuthProvider } from "@spinajs/rbac-http";
import * as OTPAuth from "otpauth";
import { Exception, InvalidOperation } from '@spinajs/exceptions';

export enum TWO_FA_METATADATA_KEYS {
    TOKEN = "2fa:token",
    ENABLED = "2fa:enabled",
    OTP = "2fa:otp",
}

@Injectable(TwoFactorAuthProvider)
export class Default2FaToken extends TwoFactorAuthProvider {
    @Config('rbac.otpauth')
    protected Config: any;

    @Logger('2fa-token')
    protected Log: Log;

    constructor() {
        super();
    }

    private _getOTP(user: User, secret: string): OTPAuth.TOTP {
        return new OTPAuth.TOTP({
            issuer: this.Config.issuer,
            label: user.Email,
            algorithm: this.Config.algorithm,
            digits: this.Config.digits,
            period: this.Config.period,
            secret: OTPAuth.Secret.fromBase32(secret),
        });

    }

    public execute(_: User): Promise<void> {
        // empty, speakasy works offline eg. google authenticator
        // we dont send any email or sms
        return Promise.resolve();
    }

    public async verifyToken(token: string, user: User): Promise<boolean> {
        const twoFaToken = user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN];

        if (!twoFaToken) {
            throw new Exception(`Cannot verify 2fa token, no 2fa token for user ${user.Uuid}`);
        }

        const totp = this._getOTP(user, twoFaToken);
        const verified = totp.validate({
            token: token,
            window: this.Config.window,
        });

        return verified !== null;
    }

    public async disable(user: User): Promise<void> {

        await user.Metadata.delete(TWO_FA_METATADATA_KEYS.TOKEN);
        await user.Metadata.delete(TWO_FA_METATADATA_KEYS.ENABLED); 
        await user.Metadata.delete(TWO_FA_METATADATA_KEYS.OTP);
       

        this.Log.trace(`2fa token removed for user ${user.Uuid}`, {
            user: {
                Uuid: user.Uuid
            },
        });
    }

    public async initialize(user: User): Promise<any> {

        if (user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]) {
            throw new InvalidOperation(`user ${user.Uuid} alread have enabled 2f, disable it first.`);
        }

        const secret = new OTPAuth.Secret({ size: this.Config.secretSize });
        const totp = this._getOTP(user, secret.base32);

        user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN] = secret.base32;
        user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED] = true;
        user.Metadata[TWO_FA_METATADATA_KEYS.OTP] = totp.toString();

        await user.Metadata.update();

        this.Log.trace(`2fa token initialized for user ${user.Uuid}`, {
            user: {
                Uuid: user.Uuid
            },
        });

        /**
         * returns: `otpauth://totp/ACME:Alice?issuer=ACME&secret=US3WHSG7X5KAPV27VANWKQHF3SH3HULL&algorithm=SHA1&digits=6&period=30`
         */
        return totp.toString();
    }

    public async getOtpAuthUrl(user: User): Promise<string | null> {
        const token = user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN];

        if (!token) {
            this.Log.trace(`Cannot get 2fa auth url, no 2fa token for user ${user.Id}`);
            return null;
        }

        const totp = this._getOTP(user, token);
        return totp.toString();
    }

    public async isEnabled(user: User): Promise<boolean> {
        const val = await user.Metadata[TWO_FA_METATADATA_KEYS.ENABLED];
        return val as boolean;
    }

    public async isInitialized(user: User): Promise<boolean> {
        const token = user.Metadata[TWO_FA_METATADATA_KEYS.TOKEN];
        return token !== null && token !== undefined && token !== '';
    }
}
