import 'mocha';
import { expect } from 'chai';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ManifestFragment } from '@spinajs/manifest';
import { hasBuiltFragments } from './support/installed-app.js';

const PACKAGES = resolve('..');

type Schema = Record<string, unknown>;

function fragmentOf(pkg: string): ManifestFragment | undefined {
  const file = join(PACKAGES, pkg, 'lib', 'manifest.fragment.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ManifestFragment) : undefined;
}

function configSchemaOf(pkg: string, id: string): Schema {
  return fragmentOf(pkg)?.schemas[id] as Schema;
}

const SUBSCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function nullSubschemas(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((member, index) => nullSubschemas(member, `${path}/${index}`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, member]) => [
    ...(SUBSCHEMA_LISTS.has(key) && Array.isArray(member) && member.includes(null) ? [`${path}/${key}`] : []),
    ...nullSubschemas(member, `${path}/${key}`),
  ]);
}

const at = (schema: Schema, ...path: string[]): Schema => path.reduce((node, key) => node[key] as Schema, schema);

describe('configuration schemas in the built fragments', () => {
  before(function () {
    if (!hasBuiltFragments()) this.skip();
  });

  it('have no null where a subschema belongs', () => {
    const found = readdirSync(PACKAGES).flatMap((pkg) => Object.entries(fragmentOf(pkg)?.schemas ?? {}).flatMap(([id, schema]) => nullSubschemas(schema).map((path) => `${id}${path}`)));
    expect(found).to.deep.equal([]);
  });

  it('authz-abac: a frozen list is read', () => {
    const stores = at(configSchemaOf('authz-abac', 'spinajs/authz-abac.configuration.schema.json'), 'properties', 'stores');
    expect(at(stores, 'items', 'enum')).to.deep.equal(['ConfigPolicyStore', 'DbPolicyStore']);
    expect(stores.default).to.not.include(null);
  });

  it('authz-rebac: a frozen list is read', () => {
    expect(at(configSchemaOf('authz-rebac', 'spinajs/authz-rebac.configuration.schema.json'), 'properties', 'store', 'enum')).to.deep.equal(['DbTupleStore', 'MemoryTupleStore']);
  });

  it('authn-http: a frozen default is read', () => {
    expect(at(configSchemaOf('authn-http', 'spinajs/authn-http.configuration.schema.json'), 'properties', 'logout', 'properties', 'clearSiteData', 'default')).to.deep.equal(['cache', 'cookies', 'storage']);
  });

  it('authn-oidc and authz-rbac: rules built by calls are published as partial, the rest as written', () => {
    const oidc = configSchemaOf('authn-oidc', 'spinajs/authn-oidc.configuration.schema.json');
    expect(oidc['x-explicit']).to.equal('partial');
    expect(at(oidc, 'properties', 'providers', 'additionalProperties', 'properties', 'preset', 'enum')).to.deep.equal(['google', 'entra', 'keycloak', 'auth0', 'okta', 'github']);

    const rbac = configSchemaOf('authz-rbac', 'spinajs/authz-rbac.configuration.schema.json');
    expect(rbac['x-explicit']).to.equal('partial');
    expect(at(rbac, 'properties', 'rules', 'items')).to.not.have.property('allOf');
  });
});
