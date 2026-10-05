import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';

/** The service principal `telemetry.auth.token` authenticates: `service:telemetry`. */
export const TELEMETRY_SERVICE = 'telemetry';

const SERVICES = ['authz', 'http', 'services'];

// The entries this module added, so a second run tells them from an app's own `telemetry` entry.
const bridged = new WeakSet<object>();

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Hands a non-empty `telemetry.auth.token` to authz-http's ServicePrincipalSource: appends to
 * `authz.http.services` the `telemetry` service on the `x-metrics-token` header and on
 * `Authorization: Bearer <token>`. An entry named `telemetry` the app configured wins, and the
 * token key is then ignored. Runs again without adding duplicates.
 */
export function bridgeTelemetryToken(cfg: Pick<Configuration, 'get' | 'set'>, log?: { info(message: string): void }): void {
  const token = cfg.get<unknown>(['telemetry', 'auth', 'token']);
  if (typeof token !== 'string' || token.length === 0) return;

  const services = cfg.get<unknown>(SERVICES) ?? [];
  // authz-http reports a malformed list when it reads it.
  if (!Array.isArray(services)) return;

  const own = services.filter((s) => isRecord(s) && s.name === TELEMETRY_SERVICE);
  if (own.length > 0) {
    if (!own.every((s) => bridged.has(s))) log?.info(`telemetry.auth.token is ignored: authz.http.services already names the ${TELEMETRY_SERVICE} service`);
    return;
  }

  // ServicePrincipalSource compares a header's whole value, and stock Prometheus scrape configs
  // send only `Authorization: Bearer <token>`, so the Bearer form is an entry of its own.
  const entries = [
    { name: TELEMETRY_SERVICE, header: 'x-metrics-token', token },
    { name: TELEMETRY_SERVICE, header: 'authorization', token: `Bearer ${token}` },
  ];
  for (const e of entries) bridged.add(e);
  cfg.set(SERVICES, [...services, ...entries]);
}

/** Runs {@link bridgeTelemetryToken} once the configuration is resolved. */
@Injectable(Bootstrapper)
export class TelemetryServiceTokenBootstrapper extends Bootstrapper {
  @Logger('telemetry')
  protected Log: Log;

  public bootstrap(): void {
    const cfg = DI.get(Configuration);
    if (cfg) bridgeTelemetryToken(cfg, this.Log);
  }
}
