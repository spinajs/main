import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthzConfigError } from '@spinajs/authz';

export interface ServicePrincipalConfig {
  readonly name: string;
  readonly header: string;
  readonly tokens: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface LinksConfig {
  readonly query: string | null;
  readonly header: string | null;
  readonly cookie: string | null;
}

/** `authz.http.*`, read and checked. */
export interface AuthzHttpConfig {
  readonly services: readonly ServicePrincipalConfig[];
  readonly explainRoute: { readonly enabled: boolean; readonly permission: string };
  readonly links: LinksConfig;
}

const nonEmpty = { type: 'string', minLength: 1 };
const nullableName = { anyOf: [nonEmpty, { type: 'null' }] };

export const AUTHZ_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-http.configuration.schema.json',
  $configurationModule: 'authz.http',
  description: 'HTTP authorization configuration (authz.http.*)',
  type: 'object',
  properties: {
    services: {
      type: 'array',
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
    explainRoute: { type: 'object', properties: { enabled: { type: 'boolean' }, permission: nonEmpty } },
    links: { type: 'object', properties: { query: nullableName, header: nullableName, cookie: nullableName } },
  },
};

@Injectable(Bootstrapper)
export class AuthzHttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(AUTHZ_HTTP_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function fail(path: string, what: string): never {
  throw new AuthzConfigError(`authz.http.${path} must be ${what}`);
}

function service(raw: unknown, i: number): ServicePrincipalConfig {
  if (!isRecord(raw)) fail(`services[${i}]`, 'an object { name, header, token }');
  const { name, header, token, attributes } = raw;
  if (!isName(name)) fail(`services[${i}].name`, 'a non-empty string');
  if (!isName(header)) fail(`services[${i}].header`, 'a non-empty string');
  const tokens = typeof token === 'string' ? [token] : token;
  if (!Array.isArray(tokens) || tokens.length === 0 || !tokens.every(isName)) fail(`services[${i}].token`, 'a non-empty string or a non-empty list of them');
  if (attributes !== undefined && !isRecord(attributes)) fail(`services[${i}].attributes`, 'an object');
  return { name, header: header.toLowerCase(), tokens, attributes: Object.freeze({ ...(attributes ?? {}) }) };
}

function optionalName(raw: Record<string, unknown>, key: keyof LinksConfig, fallback: string | null): string | null {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (v === null || isName(v)) return v;
  return fail(`links.${key}`, 'a non-empty string or null');
}

/** Reads `authz.http.*` from the DI Configuration on each call; throws AuthzConfigError on a malformed value. */
export function httpConfig(): AuthzHttpConfig {
  const raw = DI.get(Configuration)?.get<unknown>(['authz', 'http']);
  const http = isRecord(raw) ? raw : {};

  const services = http.services ?? [];
  if (!Array.isArray(services)) fail('services', 'a list');

  const explain = isRecord(http.explainRoute) ? http.explainRoute : {};
  if (explain.enabled !== undefined && typeof explain.enabled !== 'boolean') fail('explainRoute.enabled', 'a boolean');
  if (explain.permission !== undefined && !isName(explain.permission)) fail('explainRoute.permission', 'a non-empty string');

  const links = isRecord(http.links) ? http.links : {};

  return {
    services: services.map(service),
    explainRoute: { enabled: explain.enabled === true, permission: (explain.permission as string | undefined) ?? 'authz:explain' },
    links: { query: optionalName(links, 'query', 'link'), header: optionalName(links, 'header', 'X-Authz-Link'), cookie: optionalName(links, 'cookie', null) },
  };
}
