import { createHash, timingSafeEqual } from 'node:crypto';

import { Config } from '@spinajs/configuration';
import { BasePolicy, IController, IRoute, Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Injectable } from '@spinajs/di';

import { telemetrySkipsAuth } from './development.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Shared-token guard for the telemetry endpoints. Reads the expected token from
 * `telemetry.auth.token` and compares it against the `x-metrics-token` header,
 * or — equivalently — against `Authorization: Bearer <token>`. The custom
 * header name is deliberately unchanged from the retired `@spinajs/metrics`
 * package so existing scrape configs keep working; the Bearer form exists
 * because stock Prometheus / OTel-collector scrape configs can only send
 * `authorization.credentials` (a Bearer header), not arbitrary headers.
 *
 * Skipped only under the explicit development opt-in (`telemetrySkipsAuth`).
 *
 * @deprecated set the slot to `'AccessPolicy'` and give the token to a service principal in `authz.http.services`.
 */
@Injectable(BasePolicy)
export class TelemetryTokenPolicy extends BasePolicy {
  @Logger('Security')
  protected Log: Log;

  @Config('telemetry.auth.token')
  protected Token: string;

  protected HEADER_TOKEN_FIELD = 'x-metrics-token';

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (telemetrySkipsAuth()) {
      return;
    }

    const token = req.headers[this.HEADER_TOKEN_FIELD] ?? this.bearerToken(req);
    if (typeof token !== 'string' || token.length === 0) {
      this.Log.warn(`No token is set for restricted area, header field: ${this.HEADER_TOKEN_FIELD} (or Authorization: Bearer), policy: TelemetryTokenPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('access token is not set');
    }

    if (!this.matches(token)) {
      this.Log.warn(`Invalid access token received, header field: ${this.HEADER_TOKEN_FIELD}, policy: TelemetryTokenPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('invalid access token');
    }
  }

  /** Digests have one length, so the comparison time does not depend on where or whether the tokens differ. */
  protected matches(presented: string): boolean {
    const expected: unknown = this.Token;
    if (typeof expected !== 'string' || expected.length === 0) {
      return false;
    }
    return timingSafeEqual(digest(presented), digest(expected));
  }

  /** The credentials of an `Authorization: Bearer <token>` header, if present. */
  protected bearerToken(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      return undefined;
    }
    const token = auth.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
  }
}
