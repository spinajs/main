import { Config } from '@spinajs/configuration';
import { BasePolicy, IController, IRoute, Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Injectable } from '@spinajs/di';

@Injectable(BasePolicy)
export class DefaultMetricsPolicy extends BasePolicy {
  @Logger('Security')
  protected Log: Log;

  @Config('metrics.auth.token')
  protected Token: string;
 
  protected HEADER_TOKEN_FIELD = 'x-metrics-token';

  @Config('configuration.isDevelopment')
  protected isDev: boolean;


  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (this.isDev) {
      return;
    }

    const token = req.headers[this.HEADER_TOKEN_FIELD];
    if (!token) {
      this.Log.warn(`No token is set for restricted area, header field: ${this.HEADER_TOKEN_FIELD}, policy: DefaultMetricsPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('access token is not set');
    }

    if (token !== this.Token) {
      this.Log.warn(`Invalid access token received, token: ${token}, header field: ${this.HEADER_TOKEN_FIELD}, policy: DefaultMetricsPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('invalid access token');
    }
  }
}
