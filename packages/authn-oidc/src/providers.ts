import { AsyncService, Container, DI, Inject, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthenticationStrategy, IdentityLinkStore, IdentityStore } from '@spinajs/authn/contracts';
import { NonceStore } from '@spinajs/authn-orm';
import { Log, Logger } from '@spinajs/log';

import { readOidcOptions } from './options/options.js';
import type { OidcOptions } from './options/options.js';
import { OidcHttpClient } from './http/client.js';
import { OidcProvider } from './provider.js';
import { OidcStrategy } from './strategy.js';
import { isPlainObject, isRelaxedEnv } from './support.js';

/** The app env as authn-session reads it; absent means production. */
export const appEnvOf = (config: Configuration): string | undefined => config.get<string | undefined>('process.env.APP_ENV');

/**
 * The configured providers (`authn.oidc`), read and checked at boot, each with its OidcProvider (one discovery and
 * one JWKS cache for the life of the process) and its OidcStrategy. Boot fails on any invalid provider.
 */
@Singleton()
@Inject(Container)
export class OidcProviders extends AsyncService {
  @Logger('authn-oidc')
  protected Log: Log;

  public options!: OidcOptions;
  public env: string | undefined;
  public linking = { jit: false, byVerifiedEmail: false };
  protected readonly byName = new Map<string, OidcStrategy>();

  constructor(protected readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    const config = await this.container.resolve(Configuration);
    this.env = appEnvOf(config);
    const linking = config.get<{ jit?: boolean; byVerifiedEmail?: boolean } | undefined>('authn.linking');
    this.linking = { jit: linking?.jit === true, byVerifiedEmail: linking?.byVerifiedEmail === true };
    this.options = readOidcOptions(config.get('authn.oidc'), this.env, {
      linking: this.linking,
      log: { warn: (m: string) => this.Log?.warn(m) },
    });
    if (this.options.providers.size > 0) {
      const http = await this.container.resolve(OidcHttpClient);
      const nonces = await this.container.resolve(NonceStore);
      const links = await this.container.resolve(IdentityLinkStore);
      const identities = this.container.hasRegistered(IdentityStore) ? await this.container.resolve(IdentityStore) : null;
      const relaxed = isRelaxedEnv(this.env);
      for (const [name, options] of this.options.providers) {
        this.byName.set(name, new OidcStrategy({ provider: new OidcProvider(options, http, nonces, relaxed), links, identities, linking: this.linking }));
      }
    }
    await super.resolve();
  }

  public strategies(): ReadonlyMap<string, OidcStrategy> {
    return this.byName;
  }

  /** The strategy of a provider name; throws for an unknown one. */
  public strategy(name: string): OidcStrategy {
    const s = this.byName.get(name);
    if (!s) throw new Error(`authn-oidc: no provider named ${JSON.stringify(name)} in authn.oidc.providers`);
    return s;
  }
}

/**
 * Registers one AuthenticationStrategy factory per provider name, named 'oidc:<name>', so `authn.strategies` lists
 * `{ name: 'oidc:<name>', service: 'oidc:<name>' }` (D4). The core's registry finds services by registration name, and
 * one class cannot carry several names, hence one factory per provider. A name already registered in `container` is
 * left as it is.
 */
export function registerOidcStrategies(names: Iterable<string>, container: IContainer = DI.RootContainer): void {
  for (const name of names) {
    const service = `oidc:${name}`;
    if ((container.getRegisteredTypes(AuthenticationStrategy, false) ?? []).some((t) => (t as { name?: unknown }).name === service)) continue;
    const factory = async (c: IContainer) => (await c.resolve(OidcProviders)).strategy(name);
    Object.defineProperty(factory, 'name', { value: service });
    container.register(factory).as(AuthenticationStrategy);
  }
}

/** The provider names of a raw `authn.oidc` value, without checking them (boot does). */
export function providerNamesOf(raw: unknown): string[] {
  return isPlainObject(raw) && isPlainObject(raw.providers) ? Object.keys(raw.providers) : [];
}
