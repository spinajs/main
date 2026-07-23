import { Config } from '@spinajs/configuration';
import { BasePolicy, IController, IRoute, Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Injectable } from '@spinajs/di';

/**
 * Shared-token guard for the telemetry endpoints. Reads the expected token from
 * `telemetry.auth.token` and compares it against the `x-metrics-token` header.
 * The header name is deliberately unchanged from the retired
 * `@spinajs/metrics` package so existing scrape configs keep working.
 *
 * Bypassed entirely in development.
 */
@Injectable(BasePolicy)
export class TelemetryTokenPolicy extends BasePolicy {
  @Logger('Security')
  protected Log: Log;

  @Config('telemetry.auth.token')
  protected Token: string;

  @Config('configuration.isDevelopment')
  protected isDev: boolean;

  protected HEADER_TOKEN_FIELD = 'x-metrics-token';

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (this.isDev) {
      return;
    }

    const token = req.headers[this.HEADER_TOKEN_FIELD];
    if (!token) {
      this.Log.warn(`No token is set for restricted area, header field: ${this.HEADER_TOKEN_FIELD}, policy: TelemetryTokenPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('access token is not set');
    }

    if (token !== this.Token) {
      this.Log.warn(`Invalid access token received, header field: ${this.HEADER_TOKEN_FIELD}, policy: TelemetryTokenPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('invalid access token');
    }
  }
}
