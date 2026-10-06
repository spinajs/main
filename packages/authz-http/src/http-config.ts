import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';

/** One `authz.http.services` entry as configured. */
export interface ServiceEntry {
  readonly name: string;
  readonly header: string;
  /** Several for rotation. */
  readonly token: string | readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** A service entry as ServicePrincipalSource matches it. */
export interface ServicePrincipalConfig {
  readonly name: string;
  /** Lower-cased: node lower-cases the names of `req.headers`. */
  readonly header: string;
  readonly tokens: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface LinksConfig {
  readonly query: string | null;
  readonly header: string | null;
  readonly cookie: string | null;
}

/** `authz.http.*` as AUTHZ_HTTP_CONFIGURATION_SCHEMA leaves it: every key set. */
export interface AuthzHttpConfig {
  readonly services: readonly ServiceEntry[];
  readonly explainRoute: { readonly enabled: boolean; readonly permission: string };
  readonly links: LinksConfig;
  /** The domain GET /user/access and POST /user/access/check answer for. */
  readonly access: { readonly domain: string };
  /** The domain whose AuthzAdmin the authz-http-admin routes use. */
  readonly admin: { readonly domain: string };
}

const nonEmpty = { type: 'string', minLength: 1 };
// One type list, not an anyOf with a null branch: coerceTypes would turn '' into null there and accept it.
const nullableName = { type: ['string', 'null'], minLength: 1 };

export const AUTHZ_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-http.configuration.schema.json',
  $configurationModule: 'authz.http',
  description: 'HTTP authorization configuration (authz.http.*)',
  type: 'object',
  properties: {
    services: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        required: ['name', 'header', 'token'],
        properties: {
          name: nonEmpty,
          header: nonEmpty,
          token: { anyOf: [nonEmpty, { type: 'array', minItems: 1, items: nonEmpty }] },
          attributes: { type: 'object' },
        },
      },
    },
    explainRoute: {
      type: 'object',
      default: {},
      properties: { enabled: { type: 'boolean', default: false }, permission: { ...nonEmpty, default: 'authz:explain' } },
    },
    links: {
      type: 'object',
      default: {},
      properties: { query: { ...nullableName, default: 'link' }, header: { ...nullableName, default: 'X-Authz-Link' }, cookie: { ...nullableName, default: null } },
    },
    access: { type: 'object', default: {}, properties: { domain: { ...nonEmpty, default: 'root' } } },
    admin: { type: 'object', default: {}, properties: { domain: { ...nonEmpty, default: 'root' } } },
  },
};

@Injectable(Bootstrapper)
export class AuthzHttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_HTTP_CONFIGURATION_SCHEMA);
  }
}

/** The configured services as ServicePrincipalSource matches them. */
export function servicePrincipals(services: readonly ServiceEntry[]): ServicePrincipalConfig[] {
  return services.map((s) => ({
    name: s.name,
    header: s.header.toLowerCase(),
    tokens: typeof s.token === 'string' ? [s.token] : s.token,
    attributes: Object.freeze({ ...(s.attributes ?? {}) }),
  }));
}
