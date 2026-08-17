import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { Config } from '@spinajs/configuration';
import QRCode from 'qrcode';

import { buildOtpAuthUrl } from '../2fa/otpUrl.js';

interface IGenerate2FaQrOptions {
  label: string;
  issuer?: string;
  output?: string;
}

@Command('rbac:2fa-qr', 'Prints QR code for given 2fa TOTP secret or otpauth url ( scannable by eg. google authenticator )')
@Argument('secretOrUrl', true, 'base32 TOTP secret or full otpauth:// url')
@Option('-l, --label <label>', false, 'account label shown in authenticator app', 'user')
@Option('-i, --issuer <issuer>', false, 'issuer shown in authenticator app, defaults to rbac.otpauth.issuer config')
@Option('-o, --output <file>', false, 'also write QR code to png file')
export class Generate2FaQrCode extends CliCommand {
  @Logger('rbac-http-user')
  protected Log: Log;

  @Config('rbac.otpauth')
  protected OtpConfig: { issuer: string; algorithm: string; digits: number; period: number };

  public async execute(secretOrUrl: string, options: IGenerate2FaQrOptions): Promise<void> {
    const url = buildOtpAuthUrl(secretOrUrl, {
      issuer: options.issuer ?? this.OtpConfig.issuer,
      label: options.label,
      algorithm: this.OtpConfig.algorithm,
      digits: this.OtpConfig.digits,
      period: this.OtpConfig.period,
    });

    const qr = await QRCode.toString(url, { type: 'terminal', small: true });

    // straight to stdout - logger prefixes would break QR module alignment
    // and make the code unscannable
    console.log(qr);
    console.log(url);

    if (options.output) {
      await QRCode.toFile(options.output, url, { type: 'png' });
      this.Log.success(`QR code written to ${options.output}`);
    }
  }
}
