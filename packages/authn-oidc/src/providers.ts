import { Autoinject, AsyncService, DI, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { AuthenticationStrategy, IdentityLinkStore, IdentityStore } from '@spinajs/authn/contracts';
import { NonceStore } from '@spinajs/authn-orm';
import { Log, Logger } from '@spinajs/log';
import { appEnvOf } from '@spinajs/authn-session';

import { buildOidcOptions } from './options/options.js';
import type { ConfiguredOidc, OidcOptions } from './options/options.js';
import { OidcHttpClient } from './http/client.js';
import { OidcProvider } from './provider.js';
import { OidcStrategy } from './strategy.js';
import { isRelaxedEnv } from './support.js';

/**
 * The configured providers (`authn.oidc`) of a container's Configuration, read and checked at boot, each with its
 * OidcProvider (one discovery and one JWKS cache while the container lives) and its OidcStrategy. One per container,
 * as the core's services (D11). Boot fails on any invalid provider.
 */
@PerChildInstance()
export class OidcProviders extends AsyncService {
  @Logger('authn-oidc')
  protected Log: Log;

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Autoinject(OidcHttpClient)
  protected Http!: OidcHttpClient;

  @Autoinject(NonceStore)
  protected Nonces!: NonceStore;

  @Autoinject(IdentityLinkStore)
  protected Links!: IdentityLinkStore;

  @Autoinject(IdentityStore, { optional: true })
  protected Identities: IdentityStore | undefined;

  @Config('authn.oidc')
  protected Oidc: ConfiguredOidc;

  @Config('authn.linking')
  protected GlobalLinking: { jit: boolean; byVerifiedEmail: boolean } | undefined;

  public options!: OidcOptions;
  public env: string | undefined;
  public linking = { jit: false, byVerifiedEmail: false };
  protected readonly byName = new Map<string, OidcStrategy>();

  public async resolve(): Promise<void> {
    // A @Config read needs the container's Configuration resolved; the env needs the object itself (SR-16).
    this.env = appEnvOf(this.Configuration);
    // === true: the strategy reads these as truthy, and a value set at runtime never went through the schema.
    this.linking = { jit: this.GlobalLinking?.jit === true, byVerifiedEmail: this.GlobalLinking?.byVerifiedEmail === true };
    this.options = buildOidcOptions(this.Oidc, this.env, {
      linking: this.linking,
      log: { warn: (...args: unknown[]) => this.Log?.warn(...(args as Parameters<Log['warn']>)) },
    });
    if (this.options.providers.size > 0) {
      const identities = this.Identities ?? null;
      const relaxed = isRelaxedEnv(this.env);
      for (const [name, options] of this.options.providers) {
        this.byName.set(name, new OidcStrategy({ provider: new OidcProvider(options, this.Http, this.Nonces, relaxed), links: this.Links, identities, linking: this.linking }));
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

/** The provider names of an `authn.oidc` value the schema has validated. */
export function providerNamesOf(config: { readonly providers?: Readonly<Record<string, unknown>> } | undefined): string[] {
  return Object.keys(config?.providers ?? {});
}
